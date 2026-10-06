/**
 * Near-free buy — the losing side at (or under) a fraction of a cent.
 *
 * Late in a game the bots decide it is over and bid the winner at 99.9c. The
 * loser's book is then one-sided: offers at 0.1c (the mirror of those bids)
 * and NO bids at all, because a loser bid at 0.1c would instantly match a
 * winner bid at 99.9c. `BookFeed.top()` needs both sides, so every normal buy
 * read that as "no book" and refused. Sometimes the bots are wrong, the game
 * goes on, and the loser goes back to 2-5c — this is the key for that.
 *
 * It deliberately does NOT read the book. The price cap is the safety instead:
 * the order cannot pay more than the cents he typed, and if nothing is offered
 * that low it is killed for free. The fill is the bots' winner BUY at 0.999
 * paired with this loser BUY at 0.001 — the cross-token match fills.ts already
 * attributes and inverts.
 *
 * Because the cap does not follow the book, the order never goes stale. It is
 * signed once per market, amount and tick, so a press is a single POST rather
 * than the ~1.9s cold signature a fresh token would otherwise cost.
 */

import { EventEmitter } from 'node:events';
import { OrderSide, OrderType } from '@polymarket/bindings';

import { roundToTick } from './sizing.ts';
import type { ReadyOrder, SigningClient } from './presign.ts';

export interface FloorTarget {
  tokenId: string;
  tickSize: number;
  /** Dollars per press. */
  notional: number;
  /** Highest price he will pay, in CENTS (0.1 = $0.001). */
  capCents: number;
}

/** Back off this long after a failed signature before the next background try. */
const RETRY_AFTER_MS = 2_000;

/**
 * The cents cap as a legal price on this market. Rounded DOWN to the tick, so
 * it never pays more than he typed — and when the tick is too coarse to price
 * that low (0.1c on a 0.01 market), it declines rather than rounding up to 1c,
 * which would be ten times the price he chose.
 */
export function floorCap(
  capCents: number,
  tickSize: number,
): { maxPrice: number | null; declined?: string } {
  const maxPrice = roundToTick(capCents / 100, tickSize, 'down');
  if (maxPrice < tickSize - 1e-9) {
    const lowest = Number((tickSize * 100).toFixed(4));
    return {
      maxPrice: null,
      declined: `this market's tick is ${tickSize} — its lowest price is ${lowest}c, above the ${capCents}c cap`,
    };
  }
  return { maxPrice };
}

interface Signed {
  order: any;
  maxPrice: number;
  notional: number;
}

const fingerprint = (maxPrice: number, notional: number) => `${maxPrice}:${notional}`;

/**
 * One presigned near-free buy per token.
 *
 * Emits:
 *   'ready' (tokenId)  — a fresh signature is loaded
 *   'error' (err)
 */
export class FloorOrderCache extends EventEmitter {
  private cache = new Map<string, Signed>();
  /** tokenId -> fingerprint of the signature currently being fetched. */
  private inFlight = new Map<string, string>();
  private retryAt = new Map<string, number>();
  private generation = 0;

  constructor(private readonly client: SigningClient) {
    super();
  }

  /** New market: drop the old one's orders, including signatures still in flight. */
  reset(): void {
    this.generation += 1;
    this.cache.clear();
    this.inFlight.clear();
    this.retryAt.clear();
  }

  /**
   * Sign whatever is missing or no longer matches its target. Pure comparison
   * when nothing changed, so it is safe to call on every book update.
   */
  sync(targets: FloorTarget[]): void {
    for (const t of targets) {
      const { maxPrice } = floorCap(t.capCents, t.tickSize);
      const entry = this.cache.get(t.tokenId);
      if (maxPrice === null) {
        this.cache.delete(t.tokenId);
        continue;
      }
      if (entry && entry.maxPrice === maxPrice && entry.notional === t.notional) continue;
      if (entry) this.cache.delete(t.tokenId);
      if (this.inFlight.get(t.tokenId) === fingerprint(maxPrice, t.notional)) continue;
      if (Date.now() < (this.retryAt.get(t.tokenId) ?? 0)) continue;
      void this.sign(t.tokenId, maxPrice, t.notional);
    }
  }

  /** Loaded and matching what a press would send right now. */
  isReady(t: FloorTarget): boolean {
    const { maxPrice } = floorCap(t.capCents, t.tickSize);
    const entry = this.cache.get(t.tokenId);
    return Boolean(entry && entry.maxPrice === maxPrice && entry.notional === t.notional);
  }

  /**
   * The order for a keypress: from cache when it matches, otherwise signed
   * inline. Null when the cap cannot be priced on this tick.
   */
  async take(t: FloorTarget): Promise<ReadyOrder | null> {
    const { maxPrice } = floorCap(t.capCents, t.tickSize);
    if (maxPrice === null) return null;

    const entry = this.cache.get(t.tokenId);
    if (entry && entry.maxPrice === maxPrice && entry.notional === t.notional) {
      // Single use: drop it and load the next one.
      this.cache.delete(t.tokenId);
      void this.sign(t.tokenId, maxPrice, t.notional);
      return { order: entry.order, maxPrice, notional: t.notional, presigned: true, signMs: 0 };
    }

    const started = Date.now();
    const order = await this.client.createMarketOrder(request(t.tokenId, maxPrice, t.notional));
    const signMs = Date.now() - started;
    if (this.inFlight.get(t.tokenId) !== fingerprint(maxPrice, t.notional)) {
      void this.sign(t.tokenId, maxPrice, t.notional); // refill for next time
    }
    return { order, maxPrice, notional: t.notional, presigned: false, signMs };
  }

  private async sign(tokenId: string, maxPrice: number, notional: number): Promise<void> {
    const generation = this.generation;
    const id = fingerprint(maxPrice, notional);
    this.inFlight.set(tokenId, id);
    try {
      const order = await this.client.createMarketOrder(request(tokenId, maxPrice, notional));
      // Superseded by a newer amount/tick, or a market switch, while signing.
      if (generation !== this.generation || this.inFlight.get(tokenId) !== id) return;
      this.cache.set(tokenId, { order, maxPrice, notional });
      this.retryAt.delete(tokenId);
      this.emit('ready', tokenId);
    } catch (err) {
      if (generation === this.generation) this.retryAt.set(tokenId, Date.now() + RETRY_AFTER_MS);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (generation === this.generation && this.inFlight.get(tokenId) === id) {
        this.inFlight.delete(tokenId);
      }
    }
  }
}

function request(tokenId: string, maxPrice: number, notional: number) {
  return {
    tokenId,
    side: OrderSide.BUY,
    amount: notional,
    maxSpend: notional, // all-in: the number on the button is what leaves the balance
    maxPrice,
    orderType: OrderType.FAK,
  };
}
