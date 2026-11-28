export interface BackupSnapshotInfo {
  id: string;
  name: string;
  createdTime: string;
  sizeBytes?: number;
}

export interface SyncStatus {
  provider: string;
  configured: boolean;
  connected: boolean;
  email?: string;
  autoSync: boolean;
  lastSyncedAt?: string;
  lastError?: string;
  clientId?: string;
  hasClientSecret: boolean;
}

export interface SyncConfigInput {
  clientId: string;
  clientSecret?: string;
  autoSync?: boolean;
}

export interface SyncNowResult {
  ok: boolean;
  error?: string;
  added?: number;
  updated?: number;
  lastSyncedAt?: string;
}

export interface BackupActionResult {
  ok: boolean;
  error?: string;
  snapshot?: BackupSnapshotInfo;
}

export interface BackupListResult {
  ok: boolean;
  error?: string;
  backups: BackupSnapshotInfo[];
}

export interface SyncProvider {
  readonly id: string;
  getStatus(): Promise<SyncStatus>;
  configure(input: SyncConfigInput): Promise<SyncStatus>;
  setAutoSync(enabled: boolean): Promise<SyncStatus>;
  connect(): Promise<SyncStatus>;
  disconnect(): Promise<SyncStatus>;
  syncNow(): Promise<SyncNowResult>;
  createBackup(label?: string): Promise<BackupActionResult>;
  listBackups(): Promise<BackupListResult>;
  restoreBackup(snapshotId: string): Promise<{ ok: boolean; error?: string }>;
}
