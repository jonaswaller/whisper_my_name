/**
 * Electron main process: owns the session, the global hotkeys, and the window.
 *
 * Hotkeys are handled HERE rather than in the renderer deliberately.
 * `globalShortcut` fires in the main process, so a keypress reaches the POST
 * without an IPC hop or waiting on a render frame — and it fires while he is
 * watching the game fullscreen, which a focused-window handler cannot do.
 */

import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron';
import { join } from 'node:path';
import { createSecureClient } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';

import { loadDotEnv, loadCredentials } from '../agent/env.ts';
import { Session, type Action } from '../agent/session.ts';
import { loadConfig, saveConfig, validateTier, type TradingConfig } from '../agent/config.ts';
import {
  ACTIONS,
  NUMLOCK_OFF_ALIASES,
  findConflict,
  validateAccelerator,
  type ActionId,
  type Bindings,
} from '../agent/actions.ts';

// esbuild emits CJS for Electron's main process, so __dirname is the bundle's
// own directory (dist/main) — not import.meta, which CJS leaves empty.
declare const __dirname: string;
const here = __dirname;

let win: BrowserWindow | null = null;
let session: Session | null = null;
let config: TradingConfig = loadConfig();

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function pushSnapshot(): void {
  if (session) send('snapshot', session.snapshot());
}

/**
 * Register one action against its accelerator, plus the Num-Lock-off twin.
 * Without the alias, a Windows numpad with Num Lock off sends Home/Up/PgUp and
 * every hotkey silently does nothing.
 */
function bind(accelerator: string, run: () => void, label: string): void {
  const candidates = [accelerator];
  const alias = NUMLOCK_OFF_ALIASES[accelerator];
  if (alias) candidates.push(alias);

  let anyRegistered = false;
  for (const key of candidates) {
    try {
      if (globalShortcut.register(key, run)) anyRegistered = true;
    } catch (err: any) {
      send('hotkey-warning', `${key}: ${err.message}`);
    }
  }
  // Report the accelerator that is actually live. Pressing "8" when the binding
  // is "Cmd+Alt+8" looks exactly like a broken hotkey, so the keys in force are
  // always stated rather than left to be inferred.
  registered.push({ label, accelerator, ok: anyRegistered });
  if (!anyRegistered) {
    send('hotkey-warning', `could not register ${accelerator} for ${label} — another app may hold it`);
  }
}

/** Which accelerator ended up bound to which action, for the HUD. */
let registered: { label: string; accelerator: string; ok: boolean }[] = [];

/**
 * Global hotkeys fire regardless of focus — including while he is typing INSIDE
 * this window. Without suspending them, typing a limit price on the numpad
 * would place buy orders. The renderer calls this on focus and blur of any
 * price field, and the HUD shows a banner while suspended.
 */
let hotkeysSuspended = false;

function setHotkeysSuspended(suspended: boolean): void {
  hotkeysSuspended = suspended;
  if (suspended) globalShortcut.unregisterAll();
  else registerHotkeys();
  send('hotkeys-suspended', suspended);
}

function registerHotkeys(): void {
  globalShortcut.unregisterAll();
  registered = [];
  if (hotkeysSuspended) return;

  for (const spec of ACTIONS) {
    const accelerator = config.bindings[spec.id];
    if (!accelerator) continue; // deliberately unbound
    bind(accelerator, () => void runAction(spec.id), spec.id);
  }
  send('hotkeys', registered);
}

/**
 * Single dispatch point for every action, whether it came from a hotkey or a
 * button click. Both paths land here so behaviour cannot drift between them.
 */
async function runAction(id: ActionId): Promise<void> {
  if (!session) return;
  send('pressed', id);
  try {
    switch (id) {
      case 'buyA1': return void (await fire({ kind: 'buy', side: 'A', tier: 0 }));
      case 'buyA2': return void (await fire({ kind: 'buy', side: 'A', tier: 1 }));
      case 'buyA3': return void (await fire({ kind: 'buy', side: 'A', tier: 2 }));
      case 'buyB1': return void (await fire({ kind: 'buy', side: 'B', tier: 0 }));
      case 'buyB2': return void (await fire({ kind: 'buy', side: 'B', tier: 1 }));
      case 'buyB3': return void (await fire({ kind: 'buy', side: 'B', tier: 2 }));
      case 'sellA': return void (await fire({ kind: 'sell', side: 'A' }));
      case 'sellB': return void (await fire({ kind: 'sell', side: 'B' }));
      case 'sellAskA': return void (await session.sellAtAsk('A'));
      case 'sellAskB': return void (await session.sellAtAsk('B'));
      case 'sellMaxA': return void (await session.sellAtMax('A'));
      case 'sellMaxB': return void (await session.sellAtMax('B'));
      // The typed price lives in the renderer, so ask for it rather than
      // duplicating that state in the main process.
      case 'sellLimitA':
      case 'sellLimitB':
        return send('request-limit-price', id === 'sellLimitA' ? 'A' : 'B');
      case 'cancelAll': return void (await session.cancelAll());
      case 'nextMarket': return void (await session.nextMarket());
    }
  } catch (err: any) {
    send('hotkey-warning', err?.message ?? String(err));
  } finally {
    pushSnapshot();
  }
}

async function fire(action: Action): Promise<void> {
  if (!session) return;
  try {
    await session.fire(action);
  } catch (err: any) {
    send('hotkey-warning', err?.message ?? String(err));
  }
  pushSnapshot();
}

async function boot(): Promise<void> {
  win = new BrowserWindow({
    width: 880,
    height: 780,
    title: 'whisper_my_name',
    alwaysOnTop: true, // stays visible over a fullscreen stream
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(join(here, '../renderer/index.html'));

  loadDotEnv();
  let creds;
  try {
    creds = loadCredentials();
  } catch (err: any) {
    send('fatal', err.message);
    return;
  }

  try {
    const client = await createSecureClient({
      signer: privateKey(creds.privateKey),
      wallet: creds.wallet,
    });
    session = new Session(client, creds.wallet, config);
    session.on('update', pushSnapshot);
    session.on('watched-trade', (t) => send('watched-trade', t));
    await session.start();
    send('ready', {
      wallet: creds.wallet,
      walletType: client.account.walletType,
      config,
    });
  } catch (err: any) {
    send('fatal', `authentication failed: ${err.message}`);
    return;
  }

  registerHotkeys();
  pushSnapshot();
  setInterval(pushSnapshot, 500); // keep book age and warmth fresh in the UI

  // Restore the last armed market so a restart mid-match costs nothing.
  if (config.lastEventUrl) {
    try {
      await session.arm(config.lastEventUrl, config.lastMarketSlug);
    } catch {
      /* he can re-arm by hand */
    }
  }
}

ipcMain.handle('arm', async (_e, url: string, marketSlug?: string) => {
  if (!session) return { ok: false, error: 'not ready' };
  try {
    await session.arm(url, marketSlug);
    // arm() records lastEventUrl/lastMarketSlug on the session's copy. Adopt it
    // here too, or the next config edit would save this stale copy and wipe the
    // restore-on-launch.
    config = session.getConfig();
    saveConfig(config);
    return { ok: true, markets: session.listMarkets(), armed: session.getMarket()?.slug };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('set-watch-wallet', (_e, wallet: string) => {
  session?.setWatchWallet(wallet);
  config = { ...config, watchWallet: wallet };
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('list-markets', () => session?.listMarkets() ?? []);

ipcMain.handle('update-config', async (_e, next: TradingConfig) => {
  // Both sides are independent, so validate all six.
  for (const side of ['A', 'B'] as const) {
    for (const tier of next.tiers?.[side] ?? []) {
      const problem = validateTier(tier, next.maxNotionalPerOrder);
      if (problem) return { ok: false, error: `${side}: ${problem}` };
    }
  }

  // Bindings are owned HERE and changed only through 'set-binding'. The
  // renderer holds a config snapshot taken at startup, so accepting its
  // bindings would replay stale ones — editing a size would silently undo
  // every rebind made since launch.
  const { bindings: _ignored, ...editable } = next as TradingConfig & { bindings?: unknown };
  config = { ...config, ...editable, bindings: config.bindings };

  await session?.updateConfig(config);
  saveConfig(config);
  return { ok: true, config };
});

ipcMain.handle('fire', async (_e, action: Action) => {
  await fire(action);
  return { ok: true };
});

/** Buttons route through the same dispatcher the hotkeys use. */
ipcMain.handle('run-action', async (_e, id: ActionId) => {
  await runAction(id);
  return { ok: true };
});

ipcMain.handle('list-actions', () => ({ actions: ACTIONS, bindings: config.bindings }));

/**
 * Rebind one action. Clearing the accelerator (null) leaves it unbound, and
 * taking a key from another action unbinds that one rather than registering the
 * same accelerator twice — Electron would silently give it to whichever
 * registered first.
 */
ipcMain.handle('set-binding', (_e, id: ActionId, accelerator: string | null) => {
  const next: Bindings = { ...config.bindings };

  if (!accelerator) {
    delete next[id];
  } else {
    const problem = validateAccelerator(accelerator);
    if (problem) return { ok: false, error: problem, bindings: config.bindings };
    const clash = findConflict(next, accelerator, id);
    if (clash) delete next[clash];
    next[id] = accelerator;
  }

  config = { ...config, bindings: next };
  saveConfig(config);
  registerHotkeys();
  return { ok: true, bindings: config.bindings };
});

ipcMain.handle('snapshot', () => session?.snapshot() ?? null);

// --- standing orders ---------------------------------------------------------

ipcMain.handle('sell-limit', async (_e, side: 'A' | 'B', price: number) => {
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: 'enter a price first' };
  await session?.sellLimitAt(side, price);
  return { ok: true };
});

ipcMain.handle('sell-at-ask', async (_e, side: 'A' | 'B') => {
  await session?.sellAtAsk(side);
  return { ok: true };
});

ipcMain.handle('sell-at-max', async (_e, side: 'A' | 'B') => {
  await session?.sellAtMax(side);
  return { ok: true };
});

ipcMain.handle('cancel-order', async (_e, orderId: string) => {
  await session?.cancel(orderId);
  return { ok: true };
});

ipcMain.handle('cancel-all', async () => {
  await session?.cancelAll();
  return { ok: true };
});

/** Called by the renderer whenever a price field gains or loses focus. */
ipcMain.handle('suspend-hotkeys', (_e, suspended: boolean) => {
  setHotkeysSuspended(Boolean(suspended));
  return { ok: true, suspended };
});

app.whenReady().then(boot);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  session?.close();
  app.quit();
});
