import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('dejamove', {
  rpc: <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> =>
    ipcRenderer.invoke('dejamove:rpc', method, params ?? {}) as Promise<T>,
});
