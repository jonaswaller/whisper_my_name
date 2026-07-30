/**
 * Order sizing for dollar-denominated marketable buys.
 *
 * The venue denominates marketable BUYs in DOLLARS, not shares — signing spends
 * `amount` USD and delivers amount/fill_price shares, so a fill below the cap
 * overdelivers shares for the same money. That was reverse-engineered the hard
 * way in bill_sheng_code (AI_HANDOFF.md:105) and is now stated outright by the
 * SDK: `amount` on a market BUY is "Desired USD notional to buy".
 *
 * That SDK also computes makerAmount itself and keeps it 2dp-clean, so the
 * gcd share-lattice this file used to carry (ported from order.rs:2497) is
 * unnecessary — verified across notionals and prices by scripts/verify-auth.ts.
 * What is left is the part the SDK does NOT do: turning a slippage tolerance in
 * cents into a price cap, and refusing to send orders that cannot fill.
 */

/** A share cannot be worth more than $1, so no cap above this can ever fill. */
const MAX_PRICE = 0.99;

/** Round a price to the market's tick. Off-tick limits are rejected outright. */
export function roundToTick(price: number, tickSize: number, direction: 'up' | 'down'): number {
  const ticks = price / tickSize;
  const snapped = direction === 'up' ? Math.ceil(ticks - 1e-9) : Math.floor(ticks + 1e-9);
  // Re-round to kill the float error tick division reintroduces.
  return Number((snapped * tickSize).toFixed(6));
}

export interface BuyPlan {
  /** USD notional to sign — passed to the SDK as `amount`. */
  amount: number;
  /** Highest acceptable price per share — passed to the SDK as `maxPrice`. */
  maxPrice: number;
  /** Shares he receives if the whole order fills at the cap — the worst case. */
  worstCaseShares: number;
  /** Set when the cap was clamped or the order is too small to be legal. */
  warning?: string;
}

export interface BuyParams {
  /** Dollars to spend — the number on the hotkey. */
  notional: number;
  /** Best ask right now, read from the cached book. */
  bestAsk: number;
  /** Slippage tolerance in cents: 3 / 8 / 20. */
  slippageCents: number;
  tickSize: number;
  /** Venue minimum, denominated in shares (5 on the LPL markets). */
  minOrderSize: number;
}

/**
 * Turn "spend $250 on Team A, tolerate 8c" into the two numbers the SDK wants.
 *
 * The cap rounds UP to the tick — rounding down would quietly shave the
 * tolerance he asked for and turn a marginal fill into a kill.
 */
export function planBuy(p: BuyParams): BuyPlan {
  if (!(p.bestAsk > 0)) throw new Error('no ask available — book is empty or stale');
  if (!(p.notional > 0)) throw new Error(`invalid notional: ${p.notional}`);

  const rawCap = p.bestAsk + p.slippageCents / 100;
  const tickCap = roundToTick(rawCap, p.tickSize, 'up');
  const maxPrice = Math.min(tickCap, roundToTick(MAX_PRICE, p.tickSize, 'down'));

  const warnings: string[] = [];
  if (tickCap > maxPrice) {
    // e.g. ask 0.95 with 20c tolerance: only 4c of it is reachable.
    const usable = Math.round((maxPrice - p.bestAsk) * 100);
    warnings.push(`slippage clamped to ${usable}c — a share caps at $1`);
  }

  // Worst case is filling the entire notional at the cap.
  const worstCaseShares = p.notional / maxPrice;
  if (worstCaseShares < p.minOrderSize) {
    const needed = (p.minOrderSize * maxPrice).toFixed(2);
    warnings.push(`below venue minimum of ${p.minOrderSize} shares — needs >= $${needed}`);
  }

  return {
    amount: p.notional,
    maxPrice,
    worstCaseShares: Number(worstCaseShares.toFixed(2)),
    warning: warnings.length > 0 ? warnings.join('; ') : undefined,
  };
}

export interface SellPlan {
  shares: number;
  minPrice: number;
  warning?: string;
}

/**
 * Sell the whole position at market. Sells are SHARE-denominated (the SDK takes
 * `shares` + `minPrice`), which is the opposite of buys — easy to get backwards.
 */
export function planSell(params: {
  shares: number;
  bestBid: number;
  slippageCents: number;
  tickSize: number;
  minOrderSize: number;
}): SellPlan {
  if (!(params.bestBid > 0)) throw new Error('no bid available — book is empty or stale');
  if (!(params.shares > 0)) throw new Error('no position to sell');

  // Round the floor DOWN so the tolerance he asked for is fully available.
  const rawFloor = params.bestBid - params.slippageCents / 100;
  const minPrice = Math.max(roundToTick(rawFloor, params.tickSize, 'down'), params.tickSize);

  const warning =
    params.shares < params.minOrderSize
      ? `position of ${params.shares} shares is below the venue minimum of ${params.minOrderSize}`
      : undefined;

  return { shares: params.shares, minPrice, warning };
}

/**
 * Pre-flight veto, ported from `kill_unfillable_orders` (AI_HANDOFF.md:133).
 *
 * If the freshest ask sits strictly above the cap, the order cannot fill — it is
 * a guaranteed kill and a wasted round trip. An ask exactly AT the cap is
 * fillable and must pass. Costs nothing: the book is already in memory.
 *
 * Callers must skip this when the book is stale. Bill's engine fails OPEN for
 * the same reason (AI_HANDOFF.md:139): swallowing a trade he wanted is worse
 * than sending one that might kill.
 */
export function isUnfillable(bestAsk: number, maxPrice: number, tickSize: number): boolean {
  return bestAsk > maxPrice + tickSize / 2;
}
