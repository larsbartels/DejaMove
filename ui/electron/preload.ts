import { contextBridge, ipcRenderer } from 'electron';
import type { SyncConfigInput } from './sync/syncProvider';

contextBridge.exposeInMainWorld('dejamove', {
  rpc: <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> =>
    ipcRenderer.invoke('dejamove:rpc', method, params ?? {}) as Promise<T>,
  sync: {
    getStatus: () => ipcRenderer.invoke('dejamove:sync:getStatus'),
    configure: (input: SyncConfigInput) => ipcRenderer.invoke('dejamove:sync:configure', input),
    setAutoSync: (enabled: boolean) => ipcRenderer.invoke('dejamove:sync:setAutoSync', enabled),
    connect: () => ipcRenderer.invoke('dejamove:sync:connect'),
    disconnect: () => ipcRenderer.invoke('dejamove:sync:disconnect'),
    syncNow: () => ipcRenderer.invoke('dejamove:sync:syncNow'),
    createBackup: (label?: string) => ipcRenderer.invoke('dejamove:sync:createBackup', label),
    listBackups: () => ipcRenderer.invoke('dejamove:sync:listBackups'),
    restoreBackup: (snapshotId: string) =>
      ipcRenderer.invoke('dejamove:sync:restoreBackup', snapshotId),
  },
});
