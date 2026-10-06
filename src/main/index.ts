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
import {
  loadConfig,
  saveConfig,
  validateTier,
  validateStanding,
  validateFloorBuy,
  type TradingConfig,
} from '../agent/config.ts';
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

// --- stall diagnostics ------------------------------------------------------
//
// Reported symptom: a value field stops accepting input and the "hotkeys
// paused" banner sticks for 5-20s, then everything catches up on its own. In
// Electron the main process's JS thread is also the browser UI thread that
// routes input to the window, so that pattern means THIS event loop stalled.
// Nothing here fixes it; it names the culprit so the next report can.

/** The last main-thread operation that ran — what a stall is blamed on. */
let lastMainOp = 'idle';

function note(level: 'info' | 'warn' | 'error', text: string): void {
  if (session) session.note(level, text);
  else send('hotkey-warning', text);
}

/** Run a synchronous suspect and log it if it was slow enough to be felt. */
function timed<T>(label: string, fn: () => T): T {
  lastMainOp = label;
  const started = Date.now();
  try {
    return fn();
  } finally {
    const ms = Date.now() - started;
    if (ms >= 100) note('warn', `main: ${label} took ${ms}ms`);
    lastMainOp = `after ${label}`;
  }
}

/** Detect the event loop being blocked: a 200ms timer that fires late. */
function startStallWatchdog(): void {
  const period = 200;
  let expected = Date.now() + period;
  const timer = setInterval(() => {
    const lag = Date.now() - expected;
    if (lag >= 300) note('error', `main process stalled ${lag}ms (last op: ${lastMainOp})`);
    expected = Date.now() + period;
  }, period);
  timer.unref?.();
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
  // Focus can report the same state more than once (pointerdown + focus, or a
  // window-focus reconciliation). Re-registering on every duplicate `false`
  // emits another key-status update and used to churn the renderer mid-edit.
  if (hotkeysSuspended === suspended) return;
  hotkeysSuspended = suspended;
  if (suspended) timed('unregister hotkeys', () => globalShortcut.unregisterAll());
  else timed('register hotkeys', () => registerHotkeys());
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
      case 'buyB1': return void (await fire({ kind: 'buy', side: 'B', tier: 0 }));
      case 'buyB2': return void (await fire({ kind: 'buy', side: 'B', tier: 1 }));
      case 'buyFloorA': return void (await session.buyAtFloor('A'));
      case 'buyFloorB': return void (await session.buyAtFloor('B'));
      case 'sellA': return void (await fire({ kind: 'sell', side: 'A' }));
      case 'sellB': return void (await fire({ kind: 'sell', side: 'B' }));
      case 'sellAskA': return void (await session.sellAtAsk('A'));
      case 'sellAskB': return void (await session.sellAtAsk('B'));
      case 'sellMaxA': return void (await session.sellAtMax('A'));
      case 'sellMaxB': return void (await session.sellAtMax('B'));
      case 'sellBelowBidA': return void (await session.sellBelowBid('A'));
      case 'sellBelowBidB': return void (await session.sellBelowBid('B'));
      case 'buyBidA': return void (await session.buyAtBid('A'));
      case 'buyBidB': return void (await session.buyAtBid('B'));
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
  startStallWatchdog();

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
    timed('save config', () => saveConfig(config));
    return { ok: true, markets: session.listMarkets(), armed: session.getMarket()?.slug };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('set-watch-wallet', (_e, wallet: string) => {
  session?.setWatchWallet(wallet);
  config = { ...config, watchWallet: wallet };
  timed('save config', () => saveConfig(config));
  return { ok: true };
});

ipcMain.handle('list-markets', () => session?.listMarkets() ?? []);

ipcMain.handle('update-config', async (_e, next: TradingConfig) => {
  // Both sides are independent, so validate all four.
  for (const side of ['A', 'B'] as const) {
    for (const tier of next.tiers?.[side] ?? []) {
      const problem = validateTier(tier, next.maxNotionalPerOrder);
      if (problem) return { ok: false, error: `${side}: ${problem}` };
    }
  }

  const standingProblem = validateStanding({
    limitBuyNotional: next.limitBuyNotional ?? config.limitBuyNotional,
    sellBelowBidCents: next.sellBelowBidCents ?? config.sellBelowBidCents,
    maxNotionalPerOrder: next.maxNotionalPerOrder ?? config.maxNotionalPerOrder,
  });
  if (standingProblem) return { ok: false, error: standingProblem };

  const floorProblem = validateFloorBuy({
    floorBuyNotional: next.floorBuyNotional ?? config.floorBuyNotional,
    floorBuyCapCents: next.floorBuyCapCents ?? config.floorBuyCapCents,
    maxNotionalPerOrder: next.maxNotionalPerOrder ?? config.maxNotionalPerOrder,
  });
  if (floorProblem) return { ok: false, error: floorProblem };

  // Bindings are owned HERE and changed only through 'set-binding'. The
  // renderer holds a config snapshot taken at startup, so accepting its
  // bindings would replay stale ones — editing a size would silently undo
  // every rebind made since launch.
  const { bindings: _ignored, ...editable } = next as TradingConfig & { bindings?: unknown };
  config = { ...config, ...editable, bindings: config.bindings };

  await session?.updateConfig(config);
  timed('save config', () => saveConfig(config));
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

  // null, not delete: a deleted key is indistinguishable from "never set" and
  // loadConfig would hand it the default again on the next launch — which is
  // exactly the bug where keys he unbound came back after every restart.
  if (!accelerator) {
    next[id] = null;
  } else {
    const problem = validateAccelerator(accelerator);
    if (problem) return { ok: false, error: problem, bindings: config.bindings };
    const clash = findConflict(next, accelerator, id);
    if (clash) next[clash] = null;
    next[id] = accelerator;
  }

  config = { ...config, bindings: next };
  timed('save config', () => saveConfig(config));
  timed('register hotkeys', () => registerHotkeys());
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
  const started = Date.now();
  setHotkeysSuspended(Boolean(suspended));
  // The renderer compares this with its own round-trip time: a slow handler
  // is a hotkey-registration problem, a fast handler behind a slow round trip
  // is a blocked event loop somewhere else.
  return { ok: true, suspended, mainMs: Date.now() - started };
});

/** Renderer-side diagnostics, into the same log the Copy button exports. */
ipcMain.handle('note', (_e, level: 'info' | 'warn' | 'error', text: string) => {
  note(level, String(text).slice(0, 300));
  return { ok: true };
});

app.whenReady().then(boot);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  session?.close();
  app.quit();
});
