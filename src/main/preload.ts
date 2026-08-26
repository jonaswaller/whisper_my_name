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

  // Standing (GTC) sells — these rest on the book until filled or cancelled.
  sellLimit: (side: string, price: number) => ipcRenderer.invoke('sell-limit', side, price),
  sellAtAsk: (side: string) => ipcRenderer.invoke('sell-at-ask', side),
  sellAtMax: (side: string) => ipcRenderer.invoke('sell-at-max', side),
  cancelOrder: (orderId: string) => ipcRenderer.invoke('cancel-order', orderId),
  cancelAll: () => ipcRenderer.invoke('cancel-all'),
  /** Suspend global hotkeys while a price field has focus. */
  suspendHotkeys: (suspended: boolean) => ipcRenderer.invoke('suspend-hotkeys', suspended),
  /** A diagnostic line for the session log (what "Copy log" exports). */
  note: (level: string, text: string) => ipcRenderer.invoke('note', level, text),

  onSnapshot: (cb: (s: unknown) => void) =>
    ipcRenderer.on('snapshot', (_e, s) => cb(s)),
  onReady: (cb: (info: unknown) => void) => ipcRenderer.on('ready', (_e, i) => cb(i)),
  onFatal: (cb: (msg: string) => void) => ipcRenderer.on('fatal', (_e, m) => cb(m)),
  onPressed: (cb: (action: unknown) => void) =>
    ipcRenderer.on('pressed', (_e, a) => cb(a)),
  onHotkeyWarning: (cb: (msg: string) => void) =>
    ipcRenderer.on('hotkey-warning', (_e, m) => cb(m)),
  onHotkeysSuspended: (cb: (suspended: boolean) => void) =>
    ipcRenderer.on('hotkeys-suspended', (_e, s) => cb(s)),
  /** Which accelerator is actually bound to which action. */
  onHotkeys: (cb: (list: unknown) => void) => ipcRenderer.on('hotkeys', (_e, l) => cb(l)),
  platform: process.platform,

  // Every action is bindable; buttons call the same dispatcher as the keys.
  runAction: (id: string) => ipcRenderer.invoke('run-action', id),
  listActions: () => ipcRenderer.invoke('list-actions'),
  setBinding: (id: string, accelerator: string | null) =>
    ipcRenderer.invoke('set-binding', id, accelerator),
  setWatchWallet: (wallet: string) => ipcRenderer.invoke('set-watch-wallet', wallet),
  onWatchedTrade: (cb: (t: unknown) => void) =>
    ipcRenderer.on('watched-trade', (_e, t) => cb(t)),
  /** Main asks the renderer for the price typed into a side's box. */
  onRequestLimitPrice: (cb: (side: string) => void) =>
    ipcRenderer.on('request-limit-price', (_e, s) => cb(s)),
});
