/**
 * Preload bridge. The renderer gets exactly these calls and nothing else — no
 * Node, no filesystem, no access to the signing key.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  arm: (url: string, marketSlug?: string) => ipcRenderer.invoke('arm', url, marketSlug),
  listMarkets: () => ipcRenderer.invoke('list-markets'),
  updateConfig: (config: unknown) => ipcRenderer.invoke('update-config', config),
  /** Clicking a button and pressing its hotkey take the same path. */
  fire: (action: unknown) => ipcRenderer.invoke('fire', action),
  snapshot: () => ipcRenderer.invoke('snapshot'),

  onSnapshot: (cb: (s: unknown) => void) =>
    ipcRenderer.on('snapshot', (_e, s) => cb(s)),
  onReady: (cb: (info: unknown) => void) => ipcRenderer.on('ready', (_e, i) => cb(i)),
  onFatal: (cb: (msg: string) => void) => ipcRenderer.on('fatal', (_e, m) => cb(m)),
  onPressed: (cb: (action: unknown) => void) =>
    ipcRenderer.on('pressed', (_e, a) => cb(a)),
  onHotkeyWarning: (cb: (msg: string) => void) =>
    ipcRenderer.on('hotkey-warning', (_e, m) => cb(m)),
});
