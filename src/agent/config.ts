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

import {
  NUMPAD_BINDINGS as NUMPAD,
  MAC_BINDINGS as MAC,
  type Bindings as ActionBindings,
} from './actions.ts';

export interface Tier {
  label: string;
  notional: number;
  slippageCents: number;
}

/**
 * Sizes are per SIDE, not shared.
 *
 * He sizes the favourite and the underdog differently — a $250 clip on a 0.85
 * favourite is a very different bet from $250 on its 0.15 counterpart, and the
 * slippage each can bear differs too. So all six buy buttons are independent.
 */
export interface SideTiers {
  A: [Tier, Tier, Tier];
  B: [Tier, Tier, Tier];
}

export interface TradingConfig {
  tiers: SideTiers;
  /** Tolerance applied to sell hotkeys 7 and 8. */
  sellSlippageCents: number;
  /**
   * Dollars for the resting "buy at BID" key. One amount for both sides: he
   * asked for a fixed clip ($200), not a tier ladder.
   */
  limitBuyNotional: number;
  /**
   * How far under the bid the "sell below BID" key prices its standing sell.
   * Literal cents, so on a 0.001 market 1c is ten ticks — that is what he
   * asked for; tighten it here if the market is fine enough to want one tick.
   */
  sellBelowBidCents: number;
  /** Refuse to send a buy larger than this, whatever the HUD says. */
  maxNotionalPerOrder: number;
  /** Book older than this disables the unfillable veto (fails open). */
  bookFreshMs: number;
  /** Nothing is sent while true; the HUD lights up as if it were. */
  dryRun: boolean;
  /** Action id -> Electron accelerator. Any action may be bound to any key. */
  bindings: ActionBindings;
  /** Another trader to watch; their fills are alerted in the Watch tab. */
  watchWallet?: string;
  /** Last armed market, restored on launch. */
  lastEventUrl?: string;
  lastMarketSlug?: string;
}

export type { Bindings } from './actions.ts';
export { NUMPAD_BINDINGS, MAC_BINDINGS, NUMLOCK_OFF_ALIASES } from './actions.ts';

export const DEFAULT_CONFIG: TradingConfig = {
  tiers: {
    A: [
      { label: 'small', notional: 50, slippageCents: 3 },
      { label: 'semi-big', notional: 250, slippageCents: 8 },
      { label: 'big', notional: 1000, slippageCents: 20 },
    ],
    B: [
      { label: 'small', notional: 50, slippageCents: 3 },
      { label: 'semi-big', notional: 250, slippageCents: 8 },
      { label: 'big', notional: 1000, slippageCents: 20 },
    ],
  },
  sellSlippageCents: 5,
  limitBuyNotional: 200,
  sellBelowBidCents: 1,
  // A backstop against a fat-fingered edit in the HUD, not a trading limit.
  maxNotionalPerOrder: 5000,
  bookFreshMs: 1000,
  dryRun: true, // safe until deliberately turned off
  watchWallet: '0xcae693bcf9696a2ebf0a62de767719b45f354f85',
  // The product runs on Windows against a numpad; the Mac map is a dev fallback.
  bindings: process.platform === 'darwin' ? { ...MAC } : { ...NUMPAD },
};

const CONFIG_FILE = 'config.local.json';

export function configPath(root = process.cwd()): string {
  return resolve(root, CONFIG_FILE);
}

/**
 * Bindings used to be `{buyA: [k,k,k], buyB: [...], sellA, sellB, nextMarket}`.
 * They are now a flat action -> accelerator map so every action is bindable.
 * An existing config must keep working rather than silently reverting his keys.
 */
function migrateBindings(raw: any): ActionBindings {
  if (!raw || typeof raw !== 'object') return {};
  if (!Array.isArray(raw.buyA)) return raw as ActionBindings; // already flat

  const out: ActionBindings = {};
  const [a1, a2, a3] = raw.buyA ?? [];
  const [b1, b2, b3] = raw.buyB ?? [];
  if (a1) out.buyA1 = a1;
  if (a2) out.buyA2 = a2;
  if (a3) out.buyA3 = a3;
  if (b1) out.buyB1 = b1;
  if (b2) out.buyB2 = b2;
  if (b3) out.buyB3 = b3;
  if (raw.sellA) out.sellA = raw.sellA;
  if (raw.sellB) out.sellB = raw.sellB;
  if (raw.nextMarket) out.nextMarket = raw.nextMarket;
  return out;
}

/**
 * Tiers used to be one shared array of three. They are now per side, so an
 * existing config's sizes are copied to both rather than silently reset.
 */
function migrateTiers(raw: any): SideTiers {
  const fallback = () => structuredClone(DEFAULT_CONFIG.tiers);
  if (!raw) return fallback();

  if (Array.isArray(raw)) {
    if (raw.length !== 3) return fallback();
    return { A: structuredClone(raw) as SideTiers['A'], B: structuredClone(raw) as SideTiers['B'] };
  }
  const ok = (side: any) => Array.isArray(side) && side.length === 3;
  if (ok(raw.A) && ok(raw.B)) return { A: structuredClone(raw.A), B: structuredClone(raw.B) };
  return fallback();
}

export function loadConfig(root = process.cwd()): TradingConfig {
  const path = configPath(root);
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TradingConfig>;
    // Shallow merge: a config written by an older build must still boot. New
    // actions inherit their default key rather than arriving unbound.
    return {
      ...structuredClone(DEFAULT_CONFIG),
      ...parsed,
      bindings: { ...DEFAULT_CONFIG.bindings, ...migrateBindings(parsed.bindings) },
      tiers: migrateTiers(parsed.tiers),
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

/** Validate the standing-order amounts the HUD can edit. */
export function validateStanding(
  config: Pick<TradingConfig, 'limitBuyNotional' | 'sellBelowBidCents' | 'maxNotionalPerOrder'>,
): string | null {
  const { limitBuyNotional: notional, sellBelowBidCents: cents, maxNotionalPerOrder: max } = config;
  if (!Number.isFinite(notional) || notional <= 0) return 'limit buy size must be a positive number';
  if (notional > max) return `limit buy size exceeds the ${max} cap`;
  if (!Number.isFinite(cents) || cents < 0) return 'below-bid offset must be zero or more';
  if (cents > 99) return 'below-bid offset cannot exceed 99c';
  return null;
}
