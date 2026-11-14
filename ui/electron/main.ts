import { app, BrowserWindow, ipcMain } from 'electron';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

class CoreRpcClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();

  start(binaryPath: string, storagePath: string): void {
    this.proc = spawn(binaryPath, [storagePath], { stdio: ['pipe', 'pipe', 'pipe'] });

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

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: 'DejaMove',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL || !app.isPackaged) {
    const devUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  const binaryPath = resolveCoreBinary();
  const storagePath = path.join(app.getPath('userData'), 'repertoire.json');
  coreClient.start(binaryPath, storagePath);

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

app.on('window-all-closed', () => {
  coreClient.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
