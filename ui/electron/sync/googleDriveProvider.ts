import { safeStorage, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type {
  BackupActionResult,
  BackupListResult,
  BackupSnapshotInfo,
  SyncConfigInput,
  SyncNowResult,
  SyncProvider,
  SyncStatus,
} from './syncProvider';

export interface CoreRpcBridge {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

interface StoredSyncState {
  clientId: string;
  clientSecretEncrypted?: string;
  clientSecretPlain?: string;
  refreshTokenEncrypted?: string;
  refreshTokenPlain?: string;
  email?: string;
  autoSync: boolean;
  lastSyncedAt?: string;
  lastError?: string;
  driveFolderId?: string;
  backupsFolderId?: string;
  syncFileId?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface DriveFileResource {
  id: string;
  name: string;
  createdTime?: string;
  size?: string;
}

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';
const DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.file openid email';
const ROOT_FOLDER_NAME = 'DejaMove';
const BACKUPS_FOLDER_NAME = 'backups';
const SYNC_FILENAME = 'repertoire.json';

function encryptSecret(secret: string): { encrypted?: string; plain?: string } {
  if (safeStorage.isEncryptionAvailable()) {
    return { encrypted: safeStorage.encryptString(secret).toString('base64') };
  }
  return { plain: secret };
}

function decryptSecret(encrypted?: string, plain?: string): string {
  if (encrypted && safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  }
  return plain ?? '';
}

function sanitizeFilenamePart(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export class GoogleDriveSyncProvider implements SyncProvider {
  readonly id = 'google-drive';

  private readonly configPath: string;
  private state: StoredSyncState;
  private accessToken = '';
  private accessTokenExpiresAt = 0;
  private syncInFlight: Promise<SyncNowResult> | null = null;

  constructor(
    userDataDir: string,
    private readonly coreClient: CoreRpcBridge,
  ) {
    this.configPath = path.join(userDataDir, 'google-drive-sync.json');
    this.state = this.loadState();
  }

  private loadState(): StoredSyncState {
    try {
      if (!fs.existsSync(this.configPath)) {
        return { clientId: '', autoSync: false };
      }
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<StoredSyncState>;
      return {
        clientId: typeof parsed.clientId === 'string' ? parsed.clientId : '',
        clientSecretEncrypted: parsed.clientSecretEncrypted,
        clientSecretPlain: parsed.clientSecretPlain,
        refreshTokenEncrypted: parsed.refreshTokenEncrypted,
        refreshTokenPlain: parsed.refreshTokenPlain,
        email: parsed.email,
        autoSync: Boolean(parsed.autoSync),
        lastSyncedAt: parsed.lastSyncedAt,
        lastError: parsed.lastError,
        driveFolderId: parsed.driveFolderId,
        backupsFolderId: parsed.backupsFolderId,
        syncFileId: parsed.syncFileId,
      };
    } catch {
      return { clientId: '', autoSync: false };
    }
  }

  private saveState(): void {
    const dir = path.dirname(this.configPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.configPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.configPath);
  }

  private getClientSecret(): string {
    return decryptSecret(this.state.clientSecretEncrypted, this.state.clientSecretPlain);
  }

  private getRefreshToken(): string {
    return decryptSecret(this.state.refreshTokenEncrypted, this.state.refreshTokenPlain);
  }

  private setRefreshToken(token: string): void {
    const wrapped = encryptSecret(token);
    this.state.refreshTokenEncrypted = wrapped.encrypted;
    this.state.refreshTokenPlain = wrapped.plain;
  }

  private clearAuthTokens(): void {
    this.accessToken = '';
    this.accessTokenExpiresAt = 0;
    this.state.refreshTokenEncrypted = undefined;
    this.state.refreshTokenPlain = undefined;
    this.state.email = undefined;
  }

  async getStatus(): Promise<SyncStatus> {
    const refreshToken = this.getRefreshToken();
    const clientSecret = this.getClientSecret();
    return {
      provider: this.id,
      configured: this.state.clientId.trim().length > 0,
      connected: refreshToken.length > 0,
      email: this.state.email,
      autoSync: this.state.autoSync,
      lastSyncedAt: this.state.lastSyncedAt,
      lastError: this.state.lastError,
      clientId: this.state.clientId || undefined,
      hasClientSecret: clientSecret.length > 0,
    };
  }

  async configure(input: SyncConfigInput): Promise<SyncStatus> {
    const trimmedId = input.clientId.trim();
    const idChanged = trimmedId !== this.state.clientId;
    this.state.clientId = trimmedId;

    if (input.clientSecret !== undefined) {
      const trimmedSecret = input.clientSecret.trim();
      if (trimmedSecret.length > 0) {
        const wrapped = encryptSecret(trimmedSecret);
        this.state.clientSecretEncrypted = wrapped.encrypted;
        this.state.clientSecretPlain = wrapped.plain;
      } else {
        this.state.clientSecretEncrypted = undefined;
        this.state.clientSecretPlain = undefined;
      }
    }

    if (input.autoSync !== undefined) {
      this.state.autoSync = input.autoSync;
    }

    if (idChanged) {
      this.clearAuthTokens();
      this.state.driveFolderId = undefined;
      this.state.backupsFolderId = undefined;
      this.state.syncFileId = undefined;
    }

    this.state.lastError = undefined;
    this.saveState();
    return this.getStatus();
  }

  async setAutoSync(enabled: boolean): Promise<SyncStatus> {
    this.state.autoSync = enabled;
    this.saveState();
    return this.getStatus();
  }

  async connect(): Promise<SyncStatus> {
    if (!this.state.clientId.trim()) {
      throw new Error('Configure a Google OAuth Client ID before signing in.');
    }

    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const oauthState = crypto.randomBytes(16).toString('hex');

    const { code, redirectUri } = await this.waitForAuthCode(codeChallenge, oauthState);

    const tokenParams = new URLSearchParams({
      code,
      client_id: this.state.clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
    });
    const clientSecret = this.getClientSecret();
    if (clientSecret) {
      tokenParams.set('client_secret', clientSecret);
    }

    const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    });
    const tokenJson = (await tokenRes.json()) as TokenResponse;
    if (!tokenRes.ok || !tokenJson.access_token) {
      const msg = tokenJson.error_description || tokenJson.error || 'OAuth token exchange failed.';
      this.state.lastError = msg;
      this.saveState();
      throw new Error(msg);
    }

    this.accessToken = tokenJson.access_token;
    this.accessTokenExpiresAt = Date.now() + (tokenJson.expires_in ?? 3600) * 1000;
    if (tokenJson.refresh_token) {
      this.setRefreshToken(tokenJson.refresh_token);
    }

    try {
      const userRes = await fetch(GOOGLE_USERINFO_ENDPOINT, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (userRes.ok) {
        const userJson = (await userRes.json()) as { email?: string };
        this.state.email = userJson.email;
      }
    } catch {
      // Optional userinfo lookup should not fail authentication.
    }

    this.state.lastError = undefined;
    this.saveState();
    return this.getStatus();
  }

  async disconnect(): Promise<SyncStatus> {
    this.clearAuthTokens();
    this.state.lastError = undefined;
    this.saveState();
    return this.getStatus();
  }

  private waitForAuthCode(
    codeChallenge: string,
    expectedState: string,
  ): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let redirectUri = '';

      const server = http.createServer((req, res) => {
        if (!req.url || !req.url.startsWith('/oauth2callback')) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }

        const parsed = new URL(req.url, redirectUri);
        const state = parsed.searchParams.get('state');
        const error = parsed.searchParams.get('error');
        const code = parsed.searchParams.get('code');

        if (state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h3>Invalid OAuth state. Please close this tab and try again.</h3>');
          cleanup();
          reject(new Error('OAuth state mismatch.'));
          return;
        }

        if (error || !code) {
          const msg = error || 'Missing authorization code.';
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<h3>Google sign-in failed (${msg}). You can close this tab.</h3>`);
          cleanup();
          reject(new Error(`Google sign-in cancelled or failed: ${msg}`));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<h2>DejaMove connected to Google Drive</h2><p>You can close this tab and return to DejaMove.</p>',
        );
        cleanup();
        resolve({ code, redirectUri });
      });

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        server.close();
      };

      server.on('error', (err) => {
        cleanup();
        reject(err);
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo | null;
        if (!addr) {
          cleanup();
          reject(new Error('Failed to bind local OAuth callback port.'));
          return;
        }

        redirectUri = `http://127.0.0.1:${addr.port}/oauth2callback`;
        const authUrl = new URL(GOOGLE_AUTH_ENDPOINT);
        authUrl.searchParams.set('client_id', this.state.clientId);
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('scope', DRIVE_SCOPES);
        authUrl.searchParams.set('code_challenge', codeChallenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        authUrl.searchParams.set('access_type', 'offline');
        authUrl.searchParams.set('prompt', 'consent');
        authUrl.searchParams.set('state', expectedState);

        timer = setTimeout(() => {
          cleanup();
          reject(new Error('Google sign-in timed out.'));
        }, 180_000);

        void shell.openExternal(authUrl.toString());
      });
    });
  }

  private async getValidAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const refreshToken = this.getRefreshToken();
    if (!refreshToken) {
      throw new Error('Not signed in to Google Drive.');
    }

    const params = new URLSearchParams({
      client_id: this.state.clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const clientSecret = this.getClientSecret();
    if (clientSecret) {
      params.set('client_secret', clientSecret);
    }

    const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const json = (await res.json()) as TokenResponse;

    if (!res.ok || !json.access_token) {
      if (json.error === 'invalid_grant') {
        this.clearAuthTokens();
        this.state.lastError = 'Google Drive session expired. Please sign in again.';
        this.saveState();
      }
      throw new Error(json.error_description || json.error || 'Failed to refresh Google token.');
    }

    this.accessToken = json.access_token;
    this.accessTokenExpiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
    if (json.refresh_token) {
      this.setRefreshToken(json.refresh_token);
      this.saveState();
    }
    return this.accessToken;
  }

  private async driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getValidAccessToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(url, { ...init, headers });
    if (response.status === 401) {
      this.accessToken = '';
      this.accessTokenExpiresAt = 0;
      const freshToken = await this.getValidAccessToken();
      headers.set('Authorization', `Bearer ${freshToken}`);
      return fetch(url, { ...init, headers });
    }
    return response;
  }

  private async findFileInFolder(
    name: string,
    parentId?: string,
    mimeType?: string,
  ): Promise<DriveFileResource | null> {
    const clauses = [`name = '${escapeDriveQuery(name)}'`, 'trashed = false'];
    if (parentId) {
      clauses.push(`'${escapeDriveQuery(parentId)}' in parents`);
    }
    if (mimeType) {
      clauses.push(`mimeType = '${escapeDriveQuery(mimeType)}'`);
    }
    const url = new URL(DRIVE_FILES_ENDPOINT);
    url.searchParams.set('q', clauses.join(' and '));
    url.searchParams.set('fields', 'files(id, name, createdTime, size)');
    url.searchParams.set('pageSize', '10');

    const res = await this.driveFetch(url.toString());
    if (!res.ok) {
      throw new Error(`Google Drive query failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as { files?: DriveFileResource[] };
    return body.files && body.files.length > 0 ? body.files[0] : null;
  }

  private async ensureFolder(
    cachedId: string | undefined,
    name: string,
    parentId?: string,
  ): Promise<string> {
    const folderMime = 'application/vnd.google-apps.folder';
    if (cachedId) {
      const checkRes = await this.driveFetch(
        `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(cachedId)}?fields=id,trashed`,
      );
      if (checkRes.ok) {
        const meta = (await checkRes.json()) as { id?: string; trashed?: boolean };
        if (meta.id && !meta.trashed) {
          return meta.id;
        }
      }
    }

    const existing = await this.findFileInFolder(name, parentId, folderMime);
    if (existing) {
      return existing.id;
    }

    const metadata: Record<string, unknown> = {
      name,
      mimeType: folderMime,
    };
    if (parentId) {
      metadata.parents = [parentId];
    }

    const createRes = await this.driveFetch(`${DRIVE_FILES_ENDPOINT}?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });
    if (!createRes.ok) {
      throw new Error(`Failed to create Drive folder ${name}: ${await createRes.text()}`);
    }
    const created = (await createRes.json()) as { id: string };
    return created.id;
  }

  private async ensureFolderHierarchy(): Promise<{ rootId: string; backupsId: string }> {
    const rootId = await this.ensureFolder(this.state.driveFolderId, ROOT_FOLDER_NAME);
    const backupsId = await this.ensureFolder(
      this.state.backupsFolderId,
      BACKUPS_FOLDER_NAME,
      rootId,
    );
    if (this.state.driveFolderId !== rootId || this.state.backupsFolderId !== backupsId) {
      this.state.driveFolderId = rootId;
      this.state.backupsFolderId = backupsId;
      this.saveState();
    }
    return { rootId, backupsId };
  }

  private async uploadJsonMultipart(
    metadata: Record<string, unknown>,
    payload: unknown,
    existingFileId?: string,
  ): Promise<DriveFileResource> {
    const boundary = `dejamove-${crypto.randomBytes(12).toString('hex')}`;
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(payload, null, 2),
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const endpoint = existingFileId
      ? `${DRIVE_UPLOAD_ENDPOINT}/${encodeURIComponent(existingFileId)}?uploadType=multipart&fields=id,name,createdTime,size`
      : `${DRIVE_UPLOAD_ENDPOINT}?uploadType=multipart&fields=id,name,createdTime,size`;

    const res = await this.driveFetch(endpoint, {
      method: existingFileId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!res.ok) {
      throw new Error(`Google Drive upload failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as DriveFileResource;
  }

  private async downloadJsonFile(fileId: string): Promise<unknown> {
    const res = await this.driveFetch(
      `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}?alt=media`,
    );
    if (!res.ok) {
      throw new Error(`Google Drive download failed (${res.status}): ${await res.text()}`);
    }
    return res.json();
  }

  async syncNow(): Promise<SyncNowResult> {
    if (this.syncInFlight) {
      return this.syncInFlight;
    }
    this.syncInFlight = this.performSync();
    try {
      return await this.syncInFlight;
    } finally {
      this.syncInFlight = null;
    }
  }

  private async performSync(): Promise<SyncNowResult> {
    try {
      const { rootId } = await this.ensureFolderHierarchy();

      let syncFileId = this.state.syncFileId;
      let existingRemote: DriveFileResource | null = null;
      if (syncFileId) {
        const metaRes = await this.driveFetch(
          `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(syncFileId)}?fields=id,trashed`,
        );
        if (metaRes.ok) {
          const meta = (await metaRes.json()) as { id?: string; trashed?: boolean };
          if (meta.id && !meta.trashed) {
            existingRemote = { id: meta.id, name: SYNC_FILENAME };
          }
        }
      }
      if (!existingRemote) {
        existingRemote = await this.findFileInFolder(SYNC_FILENAME, rootId);
        syncFileId = existingRemote?.id;
      }

      let added = 0;
      let updated = 0;

      if (existingRemote) {
        const remotePayload = await this.downloadJsonFile(existingRemote.id);
        const mergeRes = (await this.coreClient.call('repertoire.mergeJson', {
          repertoire: remotePayload,
        })) as {
          ok: boolean;
          error?: string;
          added?: number;
          updated?: number;
        };
        if (!mergeRes.ok) {
          throw new Error(mergeRes.error || 'Failed to merge remote repertoire.');
        }
        added = mergeRes.added ?? 0;
        updated = mergeRes.updated ?? 0;
      }

      const exported = (await this.coreClient.call('repertoire.exportJson')) as {
        ok: boolean;
        repertoire: unknown;
      };
      if (!exported.ok) {
        throw new Error('Failed to export local repertoire.');
      }

      const uploaded = await this.uploadJsonMultipart(
        existingRemote ? { name: SYNC_FILENAME } : { name: SYNC_FILENAME, parents: [rootId] },
        exported.repertoire,
        syncFileId,
      );

      this.state.syncFileId = uploaded.id;
      this.state.lastSyncedAt = new Date().toISOString();
      this.state.lastError = undefined;
      this.saveState();

      return {
        ok: true,
        added,
        updated,
        lastSyncedAt: this.state.lastSyncedAt,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state.lastError = msg;
      this.saveState();
      return { ok: false, error: msg };
    }
  }

  async createBackup(label?: string): Promise<BackupActionResult> {
    try {
      const { backupsId } = await this.ensureFolderHierarchy();
      const exported = (await this.coreClient.call('repertoire.exportJson')) as {
        ok: boolean;
        repertoire: unknown;
      };
      if (!exported.ok) {
        return { ok: false, error: 'Failed to export repertoire.' };
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
      const cleanLabel = label ? sanitizeFilenamePart(label) : '';
      const filename = cleanLabel
        ? `repertoire-${stamp}-${cleanLabel}.json`
        : `repertoire-${stamp}.json`;

      const uploaded = await this.uploadJsonMultipart(
        { name: filename, parents: [backupsId] },
        exported.repertoire,
      );

      const snapshot: BackupSnapshotInfo = {
        id: uploaded.id,
        name: uploaded.name,
        createdTime: uploaded.createdTime ?? new Date().toISOString(),
        sizeBytes: uploaded.size ? Number(uploaded.size) : undefined,
      };
      return { ok: true, snapshot };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listBackups(): Promise<BackupListResult> {
    try {
      const { backupsId } = await this.ensureFolderHierarchy();
      const url = new URL(DRIVE_FILES_ENDPOINT);
      url.searchParams.set('q', `'${escapeDriveQuery(backupsId)}' in parents and trashed = false`);
      url.searchParams.set('orderBy', 'createdTime desc');
      url.searchParams.set('fields', 'files(id, name, createdTime, size)');
      url.searchParams.set('pageSize', '50');

      const res = await this.driveFetch(url.toString());
      if (!res.ok) {
        return { ok: false, error: `Failed to list backups (${res.status})`, backups: [] };
      }
      const json = (await res.json()) as { files?: DriveFileResource[] };
      const backups: BackupSnapshotInfo[] = (json.files ?? []).map((f) => ({
        id: f.id,
        name: f.name,
        createdTime: f.createdTime ?? '',
        sizeBytes: f.size ? Number(f.size) : undefined,
      }));
      return { ok: true, backups };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        backups: [],
      };
    }
  }

  async restoreBackup(snapshotId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const payload = await this.downloadJsonFile(snapshotId);
      const res = (await this.coreClient.call('repertoire.importJson', {
        repertoire: payload,
      })) as { ok: boolean; error?: string };
      if (!res.ok) {
        return { ok: false, error: res.error || 'Failed to import backup repertoire.' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
