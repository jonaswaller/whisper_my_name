/**
 * Presigned order cache — the reason a keypress is fast.
 *
 * Signing is a network round trip, not local crypto. Measured on this account:
 *   first sign against a fresh token   1,886ms
 *   subsequent signs                     334ms
 * Both are enormous next to the ~250ms the venue itself takes. So every buy the
 * hotkeys can send is signed BEFORE he presses anything, and a press is reduced
 * to a single POST of bytes that already exist.
 *
 * The hard part is staleness. An order is signed against a price cap derived
 * from the ask at signing time, and the ask moves:
 *
 *   ask RISES  -> the cap still fills, just with less slippage than asked.
 *                 Harmless; the order stays usable.
 *   ask FALLS  -> the cap is now far too generous. Ask 0.85 -> 0.70 would let
 *                 an "8c" order pay up to 0.93. This is the dangerous one, and
 *                 it is why a stale cap is never fired blindly.
 *
 * On a press we use the presigned order only if its cap is still within
 * tolerance of what we would sign right now. Otherwise we sign fresh and eat
 * the latency, because filling him at a price he did not choose is worse than
 * being slow.
 */

import { EventEmitter } from 'node:events';
import { OrderSide, OrderType } from '@polymarket/bindings';

import type { BookFeed } from './book.ts';
import { planBuy, roundToTick } from './sizing.ts';

export interface Tier {
  /** Shown on the button: 'small' | 'semi-big' | 'big'. */
  label: string;
  notional: number;
  slippageCents: number;
}

export interface PresignTarget {
  tokenId: string;
  tickSize: number;
  minOrderSize: number;
  /**
   * This side's own tiers. Sizes are per side, so the cache cannot share one
   * tier list across both tokens.
   */
  tiers: Tier[];
}

export interface SigningClient {
  createMarketOrder(request: Record<string, unknown>): Promise<any>;
}

interface CacheEntry {
  order: any;
  /** The cap this order was signed against. */
  maxPrice: number;
  notional: number;
  signedAt: number;
  /** Ask at signing time, for diagnostics. */
  askAtSign: number;
}

export interface ReadyOrder {
  order: any;
  maxPrice: number;
  notional: number;
  /** True when this came from cache; false when we had to sign inline. */
  presigned: boolean;
  /** Milliseconds spent getting a signature, ~0 on a cache hit. */
  signMs: number;
}

export interface PresignOptions {
  /**
   * How far the cap may drift, in ticks, before a cached order is refused.
   * One tick is tight enough that he never gets meaningfully worse slippage
   * than the button advertises.
   */
  driftToleranceTicks?: number;
  /** Wait this long after a book move before re-signing, to avoid thrashing. */
  debounceMs?: number;
}

const key = (tokenId: string, tierIndex: number) => `${tokenId}:${tierIndex}`;

/**
 * Emits:
 *   'ready'  (tokenId, tierIndex)  — a slot now holds a fresh signature
 *   'stale'  (tokenId, tierIndex)  — drifted; press would sign inline
 *   'error'  (err)
 */
export class PresignCache extends EventEmitter {
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Set<string>();
  private targets: PresignTarget[] = [];
  private debounce: NodeJS.Timeout | null = null;
  private generation = 0;
  private readonly driftTicks: number;
  private readonly debounceMs: number;

  constructor(
    private readonly client: SigningClient,
    private readonly book: BookFeed,
    options: PresignOptions = {},
  ) {
    super();
    this.driftTicks = options.driftToleranceTicks ?? 1;
    this.debounceMs = options.debounceMs ?? 300;
  }

  /**
   * Arm a market: sign every buy the hotkeys can send, immediately.
   *
   * Warming here rather than lazily on first press is deliberate — the cold
   * 1.9s sign would otherwise land on his first keypress of the match.
   */
  async arm(targets: PresignTarget[]): Promise<void> {
    this.generation += 1;
    this.cache.clear();
    this.inFlight.clear();
    this.targets = targets.map((t) => ({ ...t, tiers: [...t.tiers] }));

    // off() first: arm() runs again on every market switch (hotkey 9), and
    // without this each switch would stack another listener, multiplying the
    // refresh work on every book tick.
    this.book.off('update', this.onBookUpdate);
    this.book.on('update', this.onBookUpdate);
    await this.refreshAll();
  }

  /** Re-sign whatever tiers changed. Cheap to call repeatedly. */
  private onBookUpdate = (): void => {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.refreshAll();
    }, this.debounceMs);
  };

  private async refreshAll(): Promise<void> {
    const work: Promise<void>[] = [];
    for (const target of this.targets) {
      for (const [tierIndex, tier] of target.tiers.entries()) {
        if (this.needsRefresh(target, tierIndex, tier)) {
          work.push(this.sign(target, tierIndex, tier));
        }
      }
    }
    // Sign concurrently: six sequential round trips would take over a second.
    await Promise.allSettled(work);
  }

  private capFor(target: PresignTarget, tier: Tier, ask: number): number {
    return planBuy({
      notional: tier.notional,
      bestAsk: ask,
      slippageCents: tier.slippageCents,
      tickSize: target.tickSize,
      minOrderSize: target.minOrderSize,
    }).maxPrice;
  }

  private needsRefresh(target: PresignTarget, tierIndex: number, tier: Tier): boolean {
    const top = this.book.top(target.tokenId);
    if (!top) return false; // nothing to sign against yet
    const slot = key(target.tokenId, tierIndex);
    if (this.inFlight.has(slot)) return false;

    const entry = this.cache.get(slot);
    if (!entry) return true;
    if (entry.notional !== tier.notional) return true;

    const wanted = this.capFor(target, tier, top.ask);
    const driftTicks = Math.abs(wanted - entry.maxPrice) / target.tickSize;
    return driftTicks > this.driftTicks + 1e-9;
  }

  private async sign(target: PresignTarget, tierIndex: number, tier: Tier): Promise<void> {
    const top = this.book.top(target.tokenId);
    if (!top) return;
    const slot = key(target.tokenId, tierIndex);
    const generation = this.generation;

    this.inFlight.add(slot);
    try {
      const maxPrice = this.capFor(target, tier, top.ask);
      const order = await this.client.createMarketOrder({
        tokenId: target.tokenId,
        side: OrderSide.BUY,
        amount: tier.notional,
        maxSpend: tier.notional, // all-in: the button's number is what leaves the balance
        maxPrice,
        orderType: OrderType.FAK,
      });

      // A slow signature returning after re-arm belongs to a market we left.
      if (generation !== this.generation) return;

      this.cache.set(slot, {
        order,
        maxPrice,
        notional: tier.notional,
        signedAt: Date.now(),
        askAtSign: top.ask,
      });
      this.emit('ready', target.tokenId, tierIndex);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.inFlight.delete(slot);
    }
  }

  /**
   * Fetch a signed order for a keypress. Returns instantly from cache when the
   * cap is still honest, otherwise signs inline and reports how long it took.
   */
  async take(target: PresignTarget, tierIndex: number): Promise<ReadyOrder | null> {
    const tier = target.tiers[tierIndex];
    if (!tier) return null;
    const top = this.book.top(target.tokenId);
    if (!top) return null;

    const slot = key(target.tokenId, tierIndex);
    const entry = this.cache.get(slot);
    const wanted = this.capFor(target, tier, top.ask);

    if (entry && entry.notional === tier.notional) {
      const driftTicks = Math.abs(wanted - entry.maxPrice) / target.tickSize;
      if (driftTicks <= this.driftTicks + 1e-9) {
        // Consume it: a signed order is single-use, so drop it and re-sign.
        this.cache.delete(slot);
        void this.sign(target, tierIndex, tier);
        return {
          order: entry.order,
          maxPrice: entry.maxPrice,
          notional: entry.notional,
          presigned: true,
          signMs: 0,
        };
      }
      this.emit('stale', target.tokenId, tierIndex);
    }

    const started = Date.now();
    const order = await this.client.createMarketOrder({
      tokenId: target.tokenId,
      side: OrderSide.BUY,
      amount: tier.notional,
      maxSpend: tier.notional,
      maxPrice: wanted,
      orderType: OrderType.FAK,
    });
    void this.sign(target, tierIndex, tier); // refill for next time
    return {
      order,
      maxPrice: wanted,
      notional: tier.notional,
      presigned: false,
      signMs: Date.now() - started,
    };
  }

  /** Per-slot readiness for the HUD: which keys are loaded right now. */
  status(): { tokenId: string; tierIndex: number; ready: boolean; ageMs: number }[] {
    const out: { tokenId: string; tierIndex: number; ready: boolean; ageMs: number }[] = [];
    for (const target of this.targets) {
      for (let i = 0; i < target.tiers.length; i++) {
        const entry = this.cache.get(key(target.tokenId, i));
        out.push({
          tokenId: target.tokenId,
          tierIndex: i,
          ready: Boolean(entry),
          ageMs: entry ? Date.now() - entry.signedAt : -1,
        });
      }
    }
    return out;
  }

  close(): void {
    this.book.off('update', this.onBookUpdate);
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.cache.clear();
  }
}

/** Exposed for tests: the cap a tier would sign at for a given ask. */
export function capForAsk(ask: number, slippageCents: number, tickSize: number): number {
  return Math.min(
    roundToTick(ask + slippageCents / 100, tickSize, 'up'),
    roundToTick(0.99, tickSize, 'down'),
  );
}
