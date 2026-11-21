import { app, BrowserWindow, dialog, ipcMain, Menu, protocol } from 'electron';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'dejamove',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

class CoreRpcClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();

  start(binaryPath: string, storagePath: string): void {
    this.proc = spawn(binaryPath, [storagePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as {
          id?: number;
          result?: unknown;
          error?: { code: number; message: string };
        };
        if (typeof msg.id === 'number') {
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            if (msg.error) {
              entry.reject(new Error(msg.error.message));
            } else {
              entry.resolve(msg.result);
            }
          }
        }
      } catch (err) {
        console.error('Failed to parse core response:', line, err);
      }
    });

    this.proc.stderr.on('data', (chunk: Buffer) => {
      console.error('[dejamove-core]', chunk.toString());
    });

    this.proc.on('exit', (code) => {
      console.warn(`dejamove-core exited with code ${code}`);
      for (const [, entry] of this.pending) {
        entry.reject(new Error('dejamove-core process exited'));
      }
      this.pending.clear();
      this.proc = null;
    });
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.proc) {
      return Promise.reject(new Error('dejamove-core is not running'));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin.write(payload);
    });
  }

  stop(): void {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill();
      this.proc = null;
    }
  }
}

function resolveCoreBinary(): string {
  const exeName = process.platform === 'win32' ? 'dejamove-core.exe' : 'dejamove-core';
  const candidates = [
    path.join(process.resourcesPath, exeName),
    path.resolve(__dirname, '../../core/build/Release', exeName),
    path.resolve(__dirname, '../../core/build/Debug', exeName),
    path.resolve(__dirname, '../../core/build', exeName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not locate ${exeName}. Checked:\n${candidates.join('\n')}`);
}

const coreClient = new CoreRpcClient();
let mainWindow: BrowserWindow | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
});

function registerAppProtocol(): void {
  const distDir = path.resolve(__dirname, '../dist');
  protocol.handle('dejamove', async (request) => {
    let relPath = 'index.html';
    try {
      const parsed = new URL(request.url);
      const rawPath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
      if (rawPath) {
        relPath = rawPath;
      }
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    const filePath = path.resolve(distDir, relPath);
    if (filePath !== distDir && !filePath.startsWith(distDir + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const data = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = MIME_TYPES[ext] ?? 'application/octet-stream';
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: { 'Content-Type': mimeType },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}

function createWindow(): void {
  const iconPath = path.resolve(__dirname, '../build/icon.png');
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: 'DejaMove',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  if (process.env.VITE_DEV_SERVER_URL || !app.isPackaged) {
    const devUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
    void win.loadURL(devUrl);
  } else {
    void win.loadURL('dejamove://app/index.html');
  }
}

app.whenReady().then(() => {
  if (!gotLock) return;

  if (app.isPackaged) {
    Menu.setApplicationMenu(null);
  }

  registerAppProtocol();

  try {
    const binaryPath = resolveCoreBinary();
    const storagePath = path.join(app.getPath('userData'), 'repertoire.json');
    coreClient.start(binaryPath, storagePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox('DejaMove Startup Error', message);
    app.quit();
    return;
  }

  ipcMain.handle('dejamove:rpc', (_event, method: string, params?: Record<string, unknown>) =>
    coreClient.call(method, params ?? {}),
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('will-quit', () => {
  coreClient.stop();
});

app.on('window-all-closed', () => {
  coreClient.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
