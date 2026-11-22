import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const uiDir = path.join(rootDir, 'ui');

const args = new Set(process.argv.slice(2));
const isDev = args.has('--dev');
const isCheck = args.has('--check');

function resolveElectronBinary() {
  const require = createRequire(import.meta.url);
  const electronPkgPath = path.join(uiDir, 'node_modules', 'electron', 'index.js');
  if (!fs.existsSync(electronPkgPath)) {
    throw new Error('Electron is not installed in ui/. Run: npm --prefix ui install');
  }
  const electronPath = require(electronPkgPath);
  if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
    throw new Error(`Electron binary not found at: ${String(electronPath)}`);
  }
  return electronPath;
}

function findCoreBinary() {
  const exeName = process.platform === 'win32' ? 'dejamove-core.exe' : 'dejamove-core';
  const candidates = [
    path.join(rootDir, 'core', 'build', 'Release', exeName),
    path.join(rootDir, 'core', 'build', 'Debug', exeName),
    path.join(rootDir, 'core', 'build', exeName),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function checkBuildArtifacts() {
  const missing = [];
  const distIndex = path.join(uiDir, 'dist', 'index.html');
  const distElectronMain = path.join(uiDir, 'dist-electron', 'main.js');
  const coreBin = findCoreBinary();

  if (!fs.existsSync(distIndex)) {
    missing.push('ui/dist/index.html');
  }
  if (!fs.existsSync(distElectronMain)) {
    missing.push('ui/dist-electron/main.js');
  }
  if (!coreBin) {
    missing.push('core/build/Release/dejamove-core (or Debug)');
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing built artifacts (${missing.join(', ')}). Run "make build" first before launching.`,
    );
  }
}

try {
  const electronBin = resolveElectronBinary();

  if (isDev) {
    const child = spawn(electronBin, ['.'], {
      cwd: uiDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173',
      },
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
    });
    child.on('error', (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
  } else {
    checkBuildArtifacts();

    if (isCheck) {
      console.log('Ready to launch DejaMove.');
      process.exit(0);
    }

    const env = { ...process.env };
    delete env.VITE_DEV_SERVER_URL;

    const child = spawn(electronBin, ['.'], {
      cwd: uiDir,
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();
    console.log('Launched DejaMove.');
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
