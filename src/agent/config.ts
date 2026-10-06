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
  type ActionId,
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
 * slippage each can bear differs too. So all four buy buttons are independent.
 *
 * Two tiers, small and big. There used to be a "semi-big" between them; he
 * never used it and it cost him screen height, so it was removed (2026-08-26).
 * Saved configs from that era are migrated: index 0 and 2 survive, 1 is dropped.
 */
export interface SideTiers {
  A: [Tier, Tier];
  B: [Tier, Tier];
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
  /**
   * Dollars for the near-free buy (keys 2 / 5). One amount for both sides, like
   * the resting buy. See floorBuy.ts for what the key is for.
   */
  floorBuyNotional: number;
  /**
   * Highest price the near-free buy pays, in CENTS: 0.1 is $0.001, the lowest
   * price a 0.001-tick market allows. The order fires without reading the book,
   * so this cap is its only price protection and is limited to
   * MAX_FLOOR_CAP_CENTS.
   */
  floorBuyCapCents: number;
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
      { label: 'big', notional: 1000, slippageCents: 20 },
    ],
    B: [
      { label: 'small', notional: 50, slippageCents: 3 },
      { label: 'big', notional: 1000, slippageCents: 20 },
    ],
  },
  sellSlippageCents: 5,
  limitBuyNotional: 200,
  sellBelowBidCents: 1,
  floorBuyNotional: 20,
  floorBuyCapCents: 0.1,
  // A backstop against a fat-fingered edit in the HUD, not a trading limit.
  maxNotionalPerOrder: 5000,
  bookFreshMs: 1000,
  dryRun: true, // safe until deliberately turned off
  watchWallet: '0xcae693bcf9696a2ebf0a62de767719b45f354f85',
  // The product runs on Windows against a numpad; the Mac map is a dev fallback.
  bindings: process.platform === 'darwin' ? { ...MAC } : { ...NUMPAD },
};

/**
 * The near-free buy is for a book the bots think is over; it has no business
 * paying more than a few cents, and it fires without a book check.
 */
export const MAX_FLOOR_CAP_CENTS = 5;

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
  // Already flat. Explicit nulls are kept: they record an unbind he made on
  // purpose, and the default merge in loadConfig must not resurrect the key.
  if (!Array.isArray(raw.buyA)) return dropSemiBig(raw as Record<string, unknown>);

  const out: ActionBindings = {};
  // Legacy triples: [small, semi-big, big]. Semi-big no longer exists, so its
  // key is dropped and big becomes tier 2.
  const [a1, , a3] = raw.buyA ?? [];
  const [b1, , b3] = raw.buyB ?? [];
  if (a1) out.buyA1 = a1;
  if (a3) out.buyA2 = a3;
  if (b1) out.buyB1 = b1;
  if (b3) out.buyB2 = b3;
  if (raw.sellA) out.sellA = raw.sellA;
  if (raw.sellB) out.sellB = raw.sellB;
  if (raw.nextMarket) out.nextMarket = raw.nextMarket;
  return out;
}

/**
 * A flat map saved while three tiers existed has `buyA3`/`buyB3` for "big".
 * Big is now tier 2, so its key moves to `buyA2`/`buyB2` — including an
 * explicit null, so a deliberate unbind of big survives too. The old semi-big
 * key on `buyA2` is discarded with the tier.
 */
function dropSemiBig(flat: Record<string, unknown>): ActionBindings {
  const out: Record<string, unknown> = { ...flat };
  for (const side of ['A', 'B']) {
    const bigKey = `buy${side}3`;
    if (bigKey in out) {
      out[`buy${side}2`] = out[bigKey];
      delete out[bigKey];
    }
  }
  return out as ActionBindings;
}

/**
 * Saved bindings, plus the platform default for any action never bound —
 * unless that default key is already his for something else. Keys 2 and 5 sat
 * free for weeks, and a new action's default must not quietly share a key he
 * chose: Electron gives a key to only one of them. Such an action arrives
 * unbound instead, to be given a key in the Keys panel.
 */
function withDefaults(saved: ActionBindings): ActionBindings {
  const out: ActionBindings = { ...saved };
  const taken = new Set(
    Object.values(saved)
      .filter((a): a is string => typeof a === 'string' && a.length > 0)
      .map((a) => a.toLowerCase()),
  );
  for (const [id, accel] of Object.entries(DEFAULT_CONFIG.bindings) as [ActionId, string | null][]) {
    if (id in out || !accel || taken.has(accel.toLowerCase())) continue;
    out[id] = accel;
    taken.add(accel.toLowerCase());
  }
  return out;
}

/**
 * Tiers used to be one shared array of three, then three per side. They are
 * now two per side (small, big). Any saved shape must load with his sizes
 * intact rather than silently reset: a triple keeps its first and last entry.
 */
function migrateTiers(raw: any): SideTiers {
  const fallback = () => structuredClone(DEFAULT_CONFIG.tiers);
  if (!raw) return fallback();

  const pair = (side: any): [Tier, Tier] | null => {
    if (!Array.isArray(side)) return null;
    const ok = (t: any) => t && typeof t === 'object' && Number.isFinite(Number(t.notional));
    if (side.length === 2 && side.every(ok)) return structuredClone(side) as [Tier, Tier];
    if (side.length === 3 && ok(side[0]) && ok(side[2])) {
      return [structuredClone(side[0]), structuredClone(side[2])];
    }
    return null;
  };

  if (Array.isArray(raw)) {
    const shared = pair(raw);
    return shared ? { A: shared, B: structuredClone(shared) } : fallback();
  }
  const a = pair(raw.A);
  const b = pair(raw.B);
  return a && b ? { A: a, B: b } : fallback();
}

export function loadConfig(root = process.cwd()): TradingConfig {
  const path = configPath(root);
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TradingConfig>;
    // Shallow merge: a config written by an older build must still boot. New
    // actions inherit their default key rather than arriving unbound — but an
    // action saved as null stays unbound (see withDefaults).
    return {
      ...structuredClone(DEFAULT_CONFIG),
      ...parsed,
      bindings: withDefaults(migrateBindings(parsed.bindings)),
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

/** Validate the near-free buy's two HUD fields. */
export function validateFloorBuy(
  config: Pick<TradingConfig, 'floorBuyNotional' | 'floorBuyCapCents' | 'maxNotionalPerOrder'>,
): string | null {
  const { floorBuyNotional: notional, floorBuyCapCents: cents, maxNotionalPerOrder: max } = config;
  if (!Number.isFinite(notional) || notional <= 0) return 'near-free buy size must be a positive number';
  if (notional > max) return `near-free buy size exceeds the ${max} cap`;
  if (!Number.isFinite(cents) || cents <= 0) return 'near-free price must be above 0c';
  if (cents > MAX_FLOOR_CAP_CENTS) {
    return `near-free price cannot exceed ${MAX_FLOOR_CAP_CENTS}c — it fires without checking the book`;
  }
  return null;
}
