/**
 * Trading session — everything a keypress touches, in one object.
 *
 * The UI never talks to the venue directly; it arms a market, reads snapshots,
 * and calls fire(). That keeps the hot path in one auditable place.
 *
 * Hot path budget, measured on this account:
 *   book read + sizing + veto      ~0.2ms   (in memory)
 *   presigned order lookup         ~0ms     (cache hit)
 *   POST                           ~95ms warm, ~320ms observed round trip
 *   venue's own marketable hold    ~250ms   (nothing beats this)
 * So the only thing worth protecting is that signing never happens here.
 */

import { EventEmitter } from 'node:events';
import { OrderSide, OrderType } from '@polymarket/bindings';

import { BookFeed } from './book.ts';
import { FillFeed, type Fill } from './fills.ts';
import { PresignCache } from './presign.ts';
import { ConnectionWarmer } from './warmth.ts';
import { dispatch, type ExecutionResult } from './executor.ts';
import { fetchPositions } from './positions.ts';
import { planBuy, planSell, isUnfillable } from './sizing.ts';
import { resolveEvent, defaultMarket, type ArmableMarket, type ResolvedEvent } from './market.ts';
import type { TradingConfig } from './config.ts';

export type Action =
  | { kind: 'buy'; side: 'A' | 'B'; tier: number }
  | { kind: 'sell'; side: 'A' | 'B' };

export interface SideView {
  name: string;
  tokenId: string;
  bid: number | null;
  ask: number | null;
  bidSize: number;
  askSize: number;
  bookAgeMs: number;
  shares: number;
  avgPrice: number;
  /** Marked against the current bid — what he'd get selling now. */
  unrealizedPnl: number;
  /** Per-tier: cap, readiness, and whether the press would be vetoed. */
  tiers: { maxPrice: number | null; ready: boolean; unfillable: boolean; warning?: string }[];
}

export interface Snapshot {
  armed: boolean;
  eventTitle: string;
  marketQuestion: string;
  marketSlug: string;
  dryRun: boolean;
  bookLive: boolean;
  fillsLive: boolean;
  warmth: { warm: boolean; medianMs: number; coldDraws: number };
  A: SideView;
  B: SideView;
  recent: LogEntry[];
}

export interface LogEntry {
  at: number;
  level: 'info' | 'fill' | 'warn' | 'error';
  text: string;
}

/**
 * How long a sell blocks another sell of the same token. Covers the POST plus
 * the observed fill-event latency (bill_sheng_code measured p50 0.65s / p99
 * 1.45s), so the position has moved before a second press is allowed.
 */
const SELL_GUARD_MS = 2_000;

const EMPTY_SIDE: SideView = {
  name: '—',
  tokenId: '',
  bid: null,
  ask: null,
  bidSize: 0,
  askSize: 0,
  bookAgeMs: -1,
  shares: 0,
  avgPrice: 0,
  unrealizedPnl: 0,
  tiers: [],
};

export class Session extends EventEmitter {
  private book = new BookFeed();
  private fills: FillFeed;
  private presign: PresignCache;
  private warmer = new ConnectionWarmer();

  private event: ResolvedEvent | null = null;
  private market: ArmableMarket | null = null;
  private log: LogEntry[] = [];
  /** Tokens with a sell in flight; see SELL_GUARD_MS. */
  private sellInFlight = new Set<string>();

  constructor(
    private readonly client: any,
    private readonly wallet: string,
    private config: TradingConfig,
  ) {
    super();
    this.fills = new FillFeed(client);
    this.presign = new PresignCache(client, this.book, { driftToleranceTicks: 1 });

    this.book.on('error', (e) => this.push('warn', `book: ${e.message}`));
    this.book.on('status', () => this.emit('update'));
    this.fills.on('error', (e) => this.push('warn', `fills: ${e.message}`));
    this.fills.on('status', () => this.emit('update'));
    this.fills.on('fill', (f: Fill) => {
      const which = f.tokenId === this.market?.teamA.tokenId ? 'A' : 'B';
      this.push(
        'fill',
        `${f.side} ${f.size} ${which} @ ${f.price}${f.inverted ? ' (inverted)' : ''}`,
      );
    });
    this.fills.on('position', () => this.emit('update'));
    this.presign.on('ready', () => this.emit('update'));
    this.presign.on('error', (e) => this.push('warn', `presign: ${e.message}`));
    this.warmer.on('cold', (ms: number) => this.push('warn', `cold connection draw ${Math.round(ms)}ms`));
  }

  async start(): Promise<void> {
    await this.warmer.start();
    await this.fills.start();
    this.push('info', 'connection warm, fill feed up');
  }

  getConfig(): TradingConfig {
    return this.config;
  }

  /**
   * Apply an edit from the HUD. Changing a size invalidates its presigned
   * orders, so the cache re-signs at the new notional straight away.
   */
  async updateConfig(next: TradingConfig): Promise<void> {
    const sizesChanged =
      JSON.stringify(next.tiers) !== JSON.stringify(this.config.tiers);
    this.config = next;
    if (sizesChanged && this.market) {
      await this.presign.arm(this.presignTargets(), this.config.tiers);
      this.push('info', 'sizes changed — re-signed');
    }
    this.emit('update');
  }

  listMarkets(): ArmableMarket[] {
    // Moneyline only: he does not trade props, totals or handicaps.
    return (this.event?.markets ?? []).filter((m) => m.kind !== 'other');
  }

  getMarket(): ArmableMarket | null {
    return this.market;
  }

  /** Resolve a pasted URL and arm a market, warming everything before use. */
  async arm(url: string, marketSlug?: string): Promise<void> {
    const event = await resolveEvent(url);
    this.event = event;
    const market =
      (marketSlug ? event.markets.find((m) => m.slug === marketSlug) : undefined) ??
      defaultMarket(event);
    await this.armMarket(market);
    this.config.lastEventUrl = url;
    this.config.lastMarketSlug = market.slug;
  }

  /** Switch markets within the armed event — hotkey 9 during a BO3. */
  async nextMarket(): Promise<void> {
    const list = this.listMarkets();
    if (list.length < 2 || !this.market) return;
    const i = list.findIndex((m) => m.slug === this.market!.slug);
    await this.armMarket(list[(i + 1) % list.length]!);
  }

  private presignTargets() {
    const m = this.market!;
    return [m.teamA, m.teamB].map((o) => ({
      tokenId: o.tokenId,
      tickSize: m.tickSize,
      minOrderSize: m.minOrderSize,
    }));
  }

  private async armMarket(market: ArmableMarket): Promise<void> {
    this.market = market;
    const tokens = [market.teamA.tokenId, market.teamB.tokenId];

    this.book.subscribe(tokens);
    this.fills.watch(tokens);

    // Seed from the Data API: the user channel only reports fills that happen
    // while connected, so without this a sell hotkey thinks he is flat.
    try {
      const held = await fetchPositions(this.wallet);
      for (const tokenId of tokens) {
        const p = held.get(tokenId);
        if (p) this.fills.seed(tokenId, p.shares, p.avgPrice);
      }
    } catch (err: any) {
      this.push('warn', `position seed failed: ${err.message}`);
    }

    this.push('info', `armed: ${market.question}`);
    this.emit('update');

    // Wait for a book before presigning — a cap needs an ask to be derived from.
    await this.waitForBook(tokens, 10_000);
    await this.presign.arm(this.presignTargets(), this.config.tiers);
    this.push('info', 'all keys loaded');
    this.emit('update');
  }

  private async waitForBook(tokens: string[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (tokens.every((t) => this.book.top(t))) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    this.push('warn', 'no book yet — keys will sign inline until it arrives');
  }

  /**
   * Execute a hotkey. Everything here is in-memory except the POST itself.
   */
  async fire(action: Action): Promise<ExecutionResult | null> {
    const market = this.market;
    if (!market) {
      this.push('warn', 'no market armed');
      return null;
    }
    const outcome = action.side === 'A' ? market.teamA : market.teamB;
    const top = this.book.top(outcome.tokenId);
    if (!top) {
      this.push('error', `no book for ${outcome.name} — refusing to trade blind`);
      return null;
    }

    const started = Date.now();
    const target = {
      tokenId: outcome.tokenId,
      tickSize: market.tickSize,
      minOrderSize: market.minOrderSize,
    };

    if (action.kind === 'sell') {
      // A sell takes ~650ms to send, but the position only updates when the
      // fill lands (~0.65s later). Without this guard, tapping the sell key
      // twice sends two full-size sells against one position and the second
      // oversells. Buys are deliberately not guarded — repeating a buy is a
      // legitimate way to add.
      if (this.sellInFlight.has(outcome.tokenId)) {
        this.push('warn', `sell already in flight for ${outcome.name} — ignored`);
        return null;
      }

      const position = this.fills.position(outcome.tokenId);
      if (position.shares <= 0) {
        this.push('warn', `no ${outcome.name} position to sell`);
        return null;
      }
      const plan = planSell({
        shares: position.shares,
        bestBid: top.bid,
        slippageCents: this.config.sellSlippageCents,
        tickSize: market.tickSize,
        minOrderSize: market.minOrderSize,
      });
      // Sells are share-denominated and cannot be presigned usefully: the size
      // changes with every fill, so a cached one would be wrong more often than
      // right.
      this.sellInFlight.add(outcome.tokenId);
      try {
        const order = await this.client.createMarketOrder({
          tokenId: outcome.tokenId,
          side: OrderSide.SELL,
          shares: plan.shares,
          minPrice: plan.minPrice,
          orderType: OrderType.FAK,
        });
        return await this.send(
          order,
          'SELL',
          outcome.tokenId,
          `SELL ${plan.shares} ${outcome.name} floor ${plan.minPrice}`,
          started,
        );
      } finally {
        // Hold the guard past the POST until the fill has had time to land and
        // move the position. Releasing at POST-time would reopen the same race.
        setTimeout(() => this.sellInFlight.delete(outcome.tokenId), SELL_GUARD_MS);
      }
    }

    const tier = this.config.tiers[action.tier];
    if (!tier) return null;

    const plan = planBuy({
      notional: tier.notional,
      bestAsk: top.ask,
      slippageCents: tier.slippageCents,
      tickSize: market.tickSize,
      minOrderSize: market.minOrderSize,
    });

    // Server-side cap: the HUD is editable, so a fat-fingered size must not get
    // through just because it was typed.
    if (plan.amount > this.config.maxNotionalPerOrder) {
      this.push('error', `blocked: $${plan.amount} exceeds the $${this.config.maxNotionalPerOrder} cap`);
      return null;
    }

    // Free pre-flight veto. Skipped on a stale book — failing open, because
    // swallowing a trade he wanted is worse than one that might kill.
    if (top.ageMs <= this.config.bookFreshMs && isUnfillable(top.ask, plan.maxPrice, market.tickSize)) {
      this.push('warn', `vetoed: ask ${top.ask} is above the ${plan.maxPrice} cap — would kill`);
      return null;
    }

    const ready = await this.presign.take(target, action.tier);
    if (!ready) {
      this.push('error', 'could not obtain a signed order');
      return null;
    }
    if (!ready.presigned) {
      this.push('warn', `signed inline (${ready.signMs}ms) — book moved past the cached cap`);
    }
    return this.send(
      ready.order,
      'BUY',
      outcome.tokenId,
      `BUY $${ready.notional} ${outcome.name} cap ${ready.maxPrice}`,
      started,
    );
  }

  private async send(
    order: any,
    side: 'BUY' | 'SELL',
    tokenId: string,
    describe: string,
    startedAt: number,
  ): Promise<ExecutionResult | null> {
    if (this.config.dryRun) {
      this.push('info', `DRY RUN: ${describe}`);
      return null;
    }
    const result = await dispatch(this.client, order, side);
    // Register before the fill can land, so a merge match is attributed to the
    // token we traded rather than the counterparty's leg.
    if (result.orderId) this.fills.expectOrder(result.orderId, tokenId);

    const total = Date.now() - startedAt;
    if (result.verdict === 'rejected') {
      this.push('error', `${describe} -> REJECTED: ${result.error ?? 'unknown'}`);
    } else if (result.verdict === 'killed') {
      this.push('warn', `${describe} -> killed (no liquidity inside cap), free`);
    } else {
      this.push(
        'fill',
        `${describe} -> ${result.filledShares} sh @ ${result.avgPrice} in ${total}ms`,
      );
    }
    this.emit('update');
    return result;
  }

  private sideView(which: 'A' | 'B'): SideView {
    const market = this.market;
    if (!market) return { ...EMPTY_SIDE };
    const outcome = which === 'A' ? market.teamA : market.teamB;
    const top = this.book.top(outcome.tokenId);
    const position = this.fills.position(outcome.tokenId);
    const status = this.presign.status();

    const tiers = this.config.tiers.map((tier, i) => {
      if (!top) return { maxPrice: null, ready: false, unfillable: false };
      const plan = planBuy({
        notional: tier.notional,
        bestAsk: top.ask,
        slippageCents: tier.slippageCents,
        tickSize: market.tickSize,
        minOrderSize: market.minOrderSize,
      });
      const slot = status.find((s) => s.tokenId === outcome.tokenId && s.tierIndex === i);
      return {
        maxPrice: plan.maxPrice,
        ready: Boolean(slot?.ready),
        unfillable:
          top.ageMs <= this.config.bookFreshMs &&
          isUnfillable(top.ask, plan.maxPrice, market.tickSize),
        warning: plan.warning,
      };
    });

    return {
      name: outcome.name,
      tokenId: outcome.tokenId,
      bid: top?.bid ?? null,
      ask: top?.ask ?? null,
      bidSize: top?.bidSize ?? 0,
      askSize: top?.askSize ?? 0,
      bookAgeMs: top?.ageMs ?? -1,
      shares: position.shares,
      avgPrice: position.avgPrice,
      unrealizedPnl:
        top && position.shares > 0
          ? Number((position.shares * (top.bid - position.avgPrice)).toFixed(2))
          : 0,
      tiers,
    };
  }

  snapshot(): Snapshot {
    const warmth = this.warmer.status();
    return {
      armed: Boolean(this.market),
      eventTitle: this.event?.title ?? '',
      marketQuestion: this.market?.question ?? '',
      marketSlug: this.market?.slug ?? '',
      dryRun: this.config.dryRun,
      bookLive: this.book.getStatus() === 'live',
      fillsLive: this.fills.isUp(),
      warmth: { warm: warmth.warm, medianMs: warmth.medianMs, coldDraws: warmth.coldDraws },
      A: this.sideView('A'),
      B: this.sideView('B'),
      recent: this.log.slice(-40),
    };
  }

  private push(level: LogEntry['level'], text: string): void {
    this.log.push({ at: Date.now(), level, text });
    if (this.log.length > 200) this.log.shift();
    this.emit('log', { level, text });
    this.emit('update');
  }

  close(): void {
    this.presign.close();
    this.book.close();
    this.fills.close();
    this.warmer.stop();
  }
}
