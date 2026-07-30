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
  NUMLOCK_OFF_ALIASES,
  type TradingConfig,
} from '../agent/config.ts';

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
function bind(accelerator: string, run: () => void): void {
  const candidates = [accelerator];
  const alias = NUMLOCK_OFF_ALIASES[accelerator];
  if (alias) candidates.push(alias);

  for (const key of candidates) {
    try {
      const ok = globalShortcut.register(key, run);
      if (!ok) send('hotkey-warning', `could not register ${key} — another app may hold it`);
    } catch (err: any) {
      send('hotkey-warning', `${key}: ${err.message}`);
    }
  }
}

function registerHotkeys(): void {
  globalShortcut.unregisterAll();
  const b = config.bindings;

  b.buyA.forEach((key, tier) => bind(key, () => void fire({ kind: 'buy', side: 'A', tier })));
  b.buyB.forEach((key, tier) => bind(key, () => void fire({ kind: 'buy', side: 'B', tier })));
  bind(b.sellA, () => void fire({ kind: 'sell', side: 'A' }));
  bind(b.sellB, () => void fire({ kind: 'sell', side: 'B' }));
  bind(b.nextMarket, () => {
    void session?.nextMarket().then(pushSnapshot);
  });
}

async function fire(action: Action): Promise<void> {
  if (!session) return;
  // Echo the press immediately so the HUD reacts even if the venue is slow.
  send('pressed', action);
  try {
    await session.fire(action);
  } catch (err: any) {
    send('hotkey-warning', err?.message ?? String(err));
  }
  pushSnapshot();
}

async function boot(): Promise<void> {
  win = new BrowserWindow({
    width: 760,
    height: 620,
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

ipcMain.handle('list-markets', () => session?.listMarkets() ?? []);

ipcMain.handle('update-config', async (_e, next: TradingConfig) => {
  for (const tier of next.tiers) {
    const problem = validateTier(tier, next.maxNotionalPerOrder);
    if (problem) return { ok: false, error: problem };
  }
  config = { ...config, ...next };
  await session?.updateConfig(config);
  saveConfig(config);
  registerHotkeys(); // bindings may have changed
  return { ok: true, config };
});

ipcMain.handle('fire', async (_e, action: Action) => {
  await fire(action);
  return { ok: true };
});

ipcMain.handle('snapshot', () => session?.snapshot() ?? null);

app.whenReady().then(boot);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  session?.close();
  app.quit();
});
