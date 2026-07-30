/**
 * Trading config: sizes, slippage, key bindings.
 *
 * Sizes and slippage are edited live in the HUD and persisted here, so he never
 * touches a file or a terminal to change them mid-session.
 *
 * Bindings are config so the same build runs on both machines: numpad on his
 * Windows box, number row on a Mac without one. Numpad defaults register their
 * navigation twins too — with Num Lock OFF, Windows sends Home/Up/PgUp instead
 * of 7/8/9, and the hotkeys would silently do nothing.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Tier {
  label: string;
  notional: number;
  slippageCents: number;
}

export interface TradingConfig {
  tiers: Tier[];
  /** Tolerance applied to sell hotkeys 7 and 8. */
  sellSlippageCents: number;
  /** Refuse to send a buy larger than this, whatever the HUD says. */
  maxNotionalPerOrder: number;
  /** Book older than this disables the unfillable veto (fails open). */
  bookFreshMs: number;
  /** Nothing is sent while true; the HUD lights up as if it were. */
  dryRun: boolean;
  bindings: Bindings;
  /** Last armed market, restored on launch. */
  lastEventUrl?: string;
  lastMarketSlug?: string;
}

export interface Bindings {
  buyA: [string, string, string];
  buyB: [string, string, string];
  sellA: string;
  sellB: string;
  /** Cycle to the next market in the event — handy mid-BO3. */
  nextMarket: string;
}

/**
 * Electron accelerators. Each numpad key is paired with the key Windows sends
 * when Num Lock is off, so the bindings work in either state.
 */
export const NUMPAD_BINDINGS: Bindings = {
  buyA: ['num1', 'num2', 'num3'],
  buyB: ['num4', 'num5', 'num6'],
  sellA: 'num7',
  sellB: 'num8',
  nextMarket: 'num9',
};

/** Num-Lock-off equivalents, registered alongside the numpad accelerators. */
export const NUMLOCK_OFF_ALIASES: Record<string, string> = {
  num1: 'End',
  num2: 'Down',
  num3: 'PageDown',
  num4: 'Left',
  num5: 'Clear',
  num6: 'Right',
  num7: 'Home',
  num8: 'Up',
  num9: 'PageUp',
};

/** For a Mac without a numpad — the number row, which is what testing uses. */
export const NUMBER_ROW_BINDINGS: Bindings = {
  buyA: ['CommandOrControl+Alt+1', 'CommandOrControl+Alt+2', 'CommandOrControl+Alt+3'],
  buyB: ['CommandOrControl+Alt+4', 'CommandOrControl+Alt+5', 'CommandOrControl+Alt+6'],
  sellA: 'CommandOrControl+Alt+7',
  sellB: 'CommandOrControl+Alt+8',
  nextMarket: 'CommandOrControl+Alt+9',
};

export const DEFAULT_CONFIG: TradingConfig = {
  tiers: [
    { label: 'small', notional: 50, slippageCents: 3 },
    { label: 'semi-big', notional: 250, slippageCents: 8 },
    { label: 'big', notional: 1000, slippageCents: 20 },
  ],
  sellSlippageCents: 5,
  // A backstop against a fat-fingered edit in the HUD, not a trading limit.
  maxNotionalPerOrder: 5000,
  bookFreshMs: 1000,
  dryRun: true, // safe until deliberately turned off
  bindings: process.platform === 'darwin' ? NUMBER_ROW_BINDINGS : NUMPAD_BINDINGS,
};

const CONFIG_FILE = 'config.local.json';

export function configPath(root = process.cwd()): string {
  return resolve(root, CONFIG_FILE);
}

export function loadConfig(root = process.cwd()): TradingConfig {
  const path = configPath(root);
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TradingConfig>;
    // Shallow merge: a config written by an older build must still boot.
    return {
      ...structuredClone(DEFAULT_CONFIG),
      ...parsed,
      bindings: { ...DEFAULT_CONFIG.bindings, ...(parsed.bindings ?? {}) },
      tiers: parsed.tiers?.length === 3 ? parsed.tiers : structuredClone(DEFAULT_CONFIG.tiers),
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(config: TradingConfig, root = process.cwd()): void {
  writeFileSync(configPath(root), JSON.stringify(config, null, 2));
}

/**
 * Validate a live edit from the HUD. Returns the reason it was refused, or null
 * when it is acceptable.
 */
export function validateTier(tier: Tier, maxNotional: number): string | null {
  if (!Number.isFinite(tier.notional) || tier.notional <= 0) return 'size must be a positive number';
  if (tier.notional > maxNotional) return `size exceeds the ${maxNotional} cap`;
  if (!Number.isFinite(tier.slippageCents) || tier.slippageCents < 0) {
    return 'slippage must be zero or more';
  }
  if (tier.slippageCents > 99) return 'slippage cannot exceed 99c';
  return null;
}
