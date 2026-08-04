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
import { fetchPositions, type HeldPosition } from './positions.ts';
import { ActivityWatcher, type WatchedTrade } from './watcher.ts';
import { planBuy, planSell, isUnfillable } from './sizing.ts';
import {
  placeLimitSell,
  listOpenOrders,
  cancelOrder,
  cancelAllOrders,
  maxRestingPrice,
  clampPrice,
  type OpenOrder,
} from './limitOrders.ts';
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
  /** Standing orders currently resting on the book, both sides. */
  openOrders: (OpenOrder & { sideLabel: string })[];
  /** Highest price that can legally rest on this market (tick-dependent). */
  maxRestingPrice: number | null;
  /**
   * The most recent action and what became of it. Every action stamps this —
   * including ones blocked before any network call — so a stale reading can
   * never masquerade as the current one.
   */
  lastAction: {
    label: string;
    /** Round trip in ms, or null when nothing was sent. */
    ms: number | null;
    at: number;
    outcome: 'sent' | 'blocked' | 'dry';
    detail?: string;
  } | null;
  /** Every open position on the account, not just the armed market. */
  inventory: (HeldPosition & { pnl: number })[];
  /** Another trader's recent fills, newest first. */
  watched: WatchedTrade[];
  watchStatus: { wallet: string; lastPollAt: number; error: string | null };
  recent: LogEntry[];
}

export interface LogEntry {
  at: number;
  level: 'info' | 'fill' | 'warn' | 'error' | 'watch';
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
  /** Standing orders resting on the book, refreshed on a timer and after edits. */
  private openOrders: OpenOrder[] = [];
  private openOrdersTimer: NodeJS.Timeout | null = null;
  /** Last action and its outcome — the "ping" he wants to see on every press. */
  private lastAction: Snapshot['lastAction'] = null;
  /** All open positions account-wide, refreshed on a timer. */
  private inventory: (HeldPosition & { pnl: number })[] = [];
  private inventoryTimer: NodeJS.Timeout | null = null;
  private watcher: ActivityWatcher;

  constructor(
    private readonly client: any,
    private readonly wallet: string,
    private config: TradingConfig,
  ) {
    super();
    this.fills = new FillFeed(client);
    this.presign = new PresignCache(client, this.book, { driftToleranceTicks: 1 });
    this.watcher = new ActivityWatcher(config.watchWallet ?? '');
    this.watcher.on('trade', (t: WatchedTrade) => {
      const armed = this.market
        ? [this.market.teamA.tokenId, this.market.teamB.tokenId].includes(t.tokenId)
        : false;
      this.push(
        'watch',
        `WATCHED ${t.side} ${t.size} ${t.outcome} @ ${t.price} ($${t.usdc.toFixed(2)})` +
          `${armed ? '  — YOUR MARKET' : ` — ${t.title}`}`,
      );
      this.emit('watched-trade', { ...t, isArmedMarket: armed });
    });
    this.watcher.on('error', () => {}); // surfaced via watchStatus, not the log

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
    // A tick change silently invalidates every presigned cap and shifts the
    // highest legal resting price, so say so and re-sign rather than absorb it.
    this.book.on('tick-change', (tokenId: string, tick: number) => {
      const which = tokenId === this.market?.teamA.tokenId ? 'A' : 'B';
      this.push('warn', `tick size for ${which} changed to ${tick} — re-signing`);
      if (this.market) void this.presign.arm(this.presignTargets());
    });
  }

  async start(): Promise<void> {
    await this.warmer.start();
    await this.fills.start();
    // Standing orders can fill or be cancelled elsewhere (the Polymarket UI,
    // say), so poll rather than trusting our own last write.
    await this.refreshOpenOrders();
    this.openOrdersTimer = setInterval(() => void this.refreshOpenOrders(), 4_000);
    this.openOrdersTimer.unref?.();

    // Account-wide inventory, so he can see everything he holds — not just the
    // armed market, and not depending on the Polymarket UI he says lags.
    await this.refreshInventory();
    this.inventoryTimer = setInterval(() => void this.refreshInventory(), 5_000);
    this.inventoryTimer.unref?.();
    if (this.config.watchWallet) this.watcher.start();
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
      await this.presign.arm(this.presignTargets());
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

  /**
   * Record what just happened. Called on EVERY action — sent, blocked or dry —
   * because "nothing appeared to happen" is exactly when he needs to see why.
   */
  private stamp(
    label: string,
    outcome: 'sent' | 'blocked' | 'dry',
    ms: number | null,
    detail?: string,
  ): void {
    this.lastAction = { label, outcome, ms, at: Date.now(), detail };
    this.emit('update');
  }

  /**
   * Tick size to price against: the live stream value if we have one, else the
   * value Gamma reported when the market was armed. The venue changes tick as a
   * market matures, and pricing off a stale one produces off-tick rejections.
   */
  private tickFor(tokenId: string): number {
    return this.book.tickSize(tokenId) ?? this.market?.tickSize ?? 0.01;
  }

  private presignTargets() {
    const m = this.market!;
    return ([['A', m.teamA], ['B', m.teamB]] as const).map(([side, o]) => ({
      tokenId: o.tokenId,
      tickSize: this.tickFor(o.tokenId),
      minOrderSize: m.minOrderSize,
      tiers: this.config.tiers[side],
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
    await this.presign.arm(this.presignTargets());
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
    const label =
      action.kind === 'sell' ? `SELL ${action.side}` : `BUY ${action.side}${action.tier + 1}`;

    const market = this.market;
    if (!market) {
      this.stamp(label, 'blocked', null, 'no market armed');
      this.push('warn', 'no market armed');
      return null;
    }
    const outcome = action.side === 'A' ? market.teamA : market.teamB;
    const top = this.book.top(outcome.tokenId);
    if (!top) {
      this.stamp(label, 'blocked', null, 'no book');
      this.push('error', `no book for ${outcome.name} — refusing to trade blind`);
      return null;
    }

    const started = Date.now();
    const target = {
      tokenId: outcome.tokenId,
      tickSize: this.tickFor(outcome.tokenId),
      minOrderSize: market.minOrderSize,
      tiers: this.config.tiers[action.side],
    };

    if (action.kind === 'sell') {
      // A sell takes ~650ms to send, but the position only updates when the
      // fill lands (~0.65s later). Without this guard, tapping the sell key
      // twice sends two full-size sells against one position and the second
      // oversells. Buys are deliberately not guarded — repeating a buy is a
      // legitimate way to add.
      if (this.sellInFlight.has(outcome.tokenId)) {
        this.stamp(label, 'blocked', null, 'a sell is already in flight');
        this.push('warn', `sell already in flight for ${outcome.name} — ignored`);
        return null;
      }

      const position = this.fills.position(outcome.tokenId);
      if (position.shares <= 0) {
        this.stamp(label, 'blocked', null, 'no position to sell');
        this.push('warn', `no ${outcome.name} position to sell`);
        return null;
      }
      const plan = planSell({
        shares: position.shares,
        bestBid: top.bid,
        slippageCents: this.config.sellSlippageCents,
        tickSize: this.tickFor(outcome.tokenId),
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

    const tier = this.config.tiers[action.side][action.tier];
    if (!tier) return null;

    const plan = planBuy({
      notional: tier.notional,
      bestAsk: top.ask,
      slippageCents: tier.slippageCents,
      tickSize: this.tickFor(outcome.tokenId),
      minOrderSize: market.minOrderSize,
    });

    // Server-side cap: the HUD is editable, so a fat-fingered size must not get
    // through just because it was typed.
    if (plan.amount > this.config.maxNotionalPerOrder) {
      this.stamp(label, 'blocked', null, `over the $${this.config.maxNotionalPerOrder} cap`);
      this.push('error', `blocked: $${plan.amount} exceeds the $${this.config.maxNotionalPerOrder} cap`);
      return null;
    }

    // Free pre-flight veto. Skipped on a stale book — failing open, because
    // swallowing a trade he wanted is worse than one that might kill.
    if (top.ageMs <= this.config.bookFreshMs && isUnfillable(top.ask, plan.maxPrice, this.tickFor(outcome.tokenId))) {
      this.stamp(label, 'blocked', null, `ask ${top.ask} above the ${plan.maxPrice} cap`);
      this.push('warn', `vetoed: ask ${top.ask} is above the ${plan.maxPrice} cap — would kill`);
      return null;
    }

    const ready = await this.presign.take(target, action.tier);
    if (!ready) {
      this.stamp(label, 'blocked', null, 'could not sign an order');
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

  // --- standing (GTC) sell orders ------------------------------------------
  //
  // These REST on the book until filled or cancelled, unlike every other order
  // this app sends. He gets three ways to price one: an exact price he types,
  // the current ask (capturing the spread instead of crossing it), and the
  // highest price the market allows (a near-resolution exit).

  /** Sell the whole position at an exact price he chose. */
  async sellLimitAt(side: 'A' | 'B', price: number): Promise<void> {
    return this.placeStandingSell(side, price, `at ${price}`);
  }

  /**
   * Sell at the current ASK rather than the bid.
   *
   * Selling at the bid crosses the spread and pays it away. Resting at the ask
   * joins the offer queue and captures it — but it only fills if someone lifts
   * the offer, so it can sit unfilled if the market walks away.
   */
  async sellAtAsk(side: 'A' | 'B'): Promise<void> {
    const market = this.market;
    if (!market) return;
    const outcome = side === 'A' ? market.teamA : market.teamB;
    const top = this.book.top(outcome.tokenId);
    if (!top) {
      this.push('error', `no book for ${outcome.name}`);
      return;
    }
    return this.placeStandingSell(side, top.ask, `at the ask (${top.ask})`);
  }

  /**
   * Sell at the highest price this market permits — 0.999 where the tick is
   * 0.001, 0.99 where it is 0.01. Effectively "exit at resolution value".
   */
  async sellAtMax(side: 'A' | 'B'): Promise<void> {
    const market = this.market;
    if (!market) return;
    const outcome = side === 'A' ? market.teamA : market.teamB;
    const tick = this.tickFor(outcome.tokenId);
    return this.placeStandingSell(side, maxRestingPrice(tick), `at ${maxRestingPrice(tick)}`);
  }

  private async placeStandingSell(
    side: 'A' | 'B',
    price: number,
    describe: string,
  ): Promise<void> {
    const market = this.market;
    if (!market) {
      this.stamp(`LIMIT SELL ${side}`, 'blocked', null, 'no market armed');
      this.push('warn', 'no market armed');
      return;
    }
    const outcome = side === 'A' ? market.teamA : market.teamB;
    const position = this.fills.position(outcome.tokenId);

    // Only count shares not already committed to a resting sell, so repeated
    // presses cannot offer the same shares twice.
    const alreadyResting = this.openOrders
      .filter((o) => o.tokenId === outcome.tokenId && o.side === 'SELL')
      .reduce((sum, o) => sum + o.remaining, 0);
    const available = Number((position.shares - alreadyResting).toFixed(6));

    if (available <= 0) {
      this.stamp(
        `LIMIT SELL ${side}`,
        'blocked',
        null,
        alreadyResting > 0 ? 'already all resting' : 'no position',
      );
      this.push(
        'warn',
        alreadyResting > 0
          ? `all ${position.shares} ${outcome.name} shares are already resting`
          : `no ${outcome.name} position to sell`,
      );
      return;
    }

    const preview = clampPrice(price, this.tickFor(outcome.tokenId));
    if (this.config.dryRun) {
      this.stamp(`LIMIT SELL ${side} @ ${preview.price}`, 'dry', null);
      this.push('info', `DRY RUN: standing SELL ${available} ${outcome.name} ${describe} -> ${preview.price}`);
      return;
    }

    const started = Date.now();
    const result = await placeLimitSell(this.client, {
      tokenId: outcome.tokenId,
      shares: available,
      price,
      tickSize: this.tickFor(outcome.tokenId),
      minOrderSize: market.minOrderSize,
    });
    const elapsed = Date.now() - started;

    if (!result.ok) {
      this.stamp(`LIMIT SELL ${side}`, 'blocked', elapsed, result.error);
      this.push('error', `standing SELL ${describe} rejected: ${result.error}`);
    } else {
      this.stamp(`LIMIT SELL ${side} @ ${result.price}`, 'sent', elapsed);
      this.push(
        'fill',
        `standing SELL ${result.shares} ${outcome.name} @ ${result.price} resting` +
          `${result.adjusted ? ` (${result.adjusted})` : ''}  ${elapsed}ms`,
      );
      if (result.orderId) this.fills.expectOrder(result.orderId, outcome.tokenId);
    }
    await this.refreshOpenOrders();
  }

  async cancel(orderId: string): Promise<void> {
    const started = Date.now();
    const res = await cancelOrder(this.client, orderId);
    const elapsed = Date.now() - started;
    this.stamp('CANCEL', res.ok ? 'sent' : 'blocked', elapsed, res.error);
    this.push(
      res.ok ? 'info' : 'error',
      res.ok ? `cancelled ${orderId.slice(0, 10)}…  ${elapsed}ms` : `cancel failed: ${res.error}`,
    );
    await this.refreshOpenOrders();
  }

  async cancelAll(): Promise<void> {
    const started = Date.now();
    const res = await cancelAllOrders(this.client);
    const elapsed = Date.now() - started;
    this.stamp('CANCEL ALL', res.ok ? 'sent' : 'blocked', elapsed, res.error);
    this.push(
      res.ok ? 'info' : 'error',
      res.ok ? `cancelled all resting orders  ${elapsed}ms` : `cancel-all failed: ${res.error}`,
    );
    await this.refreshOpenOrders();
  }

  /** Every open position on the account, with live PnL where we have a book. */
  async refreshInventory(): Promise<void> {
    try {
      const held = await fetchPositions(this.wallet);
      this.inventory = [...held.values()].map((p) => {
        // Prefer our streaming bid over the API's mark, which lags.
        const top = this.book.top(p.tokenId);
        const mark = top?.bid ?? p.curPrice;
        return { ...p, pnl: Number((p.shares * (mark - p.avgPrice)).toFixed(2)) };
      });
      this.emit('update');
    } catch {
      /* transient; the next tick retries */
    }
  }

  /** Point the activity watcher at a different trader. */
  setWatchWallet(wallet: string): void {
    this.config.watchWallet = wallet;
    this.watcher.setWallet(wallet);
    if (wallet) this.watcher.start();
    else this.watcher.stop();
    this.emit('update');
  }

  /** Re-read what is resting. Cheap, and the only truth about committed size. */
  async refreshOpenOrders(): Promise<void> {
    try {
      this.openOrders = await listOpenOrders(this.client);
      this.emit('update');
    } catch (err: any) {
      this.push('warn', `open orders: ${err.message}`);
    }
  }

  private async send(
    order: any,
    side: 'BUY' | 'SELL',
    tokenId: string,
    describe: string,
    startedAt: number,
  ): Promise<ExecutionResult | null> {
    if (this.config.dryRun) {
      this.stamp(describe, 'dry', null);
      this.push('info', `DRY RUN: ${describe}`);
      return null;
    }
    const result = await dispatch(this.client, order, side);
    // Register before the fill can land, so a merge match is attributed to the
    // token we traded rather than the counterparty's leg.
    if (result.orderId) this.fills.expectOrder(result.orderId, tokenId);

    const total = Date.now() - startedAt;
    if (result.verdict === 'rejected') {
      this.stamp(describe, 'blocked', total, result.error);
      this.push('error', `${describe} -> REJECTED: ${result.error ?? 'unknown'}  ${total}ms`);
    } else if (result.verdict === 'killed') {
      this.stamp(describe, 'sent', total, 'killed — no liquidity inside cap');
      this.push('warn', `${describe} -> killed (no liquidity inside cap), free  ${total}ms`);
    } else {
      this.stamp(describe, 'sent', total);
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

    const tiers = this.config.tiers[which].map((tier, i) => {
      if (!top) return { maxPrice: null, ready: false, unfillable: false };
      const plan = planBuy({
        notional: tier.notional,
        bestAsk: top.ask,
        slippageCents: tier.slippageCents,
        tickSize: this.tickFor(outcome.tokenId),
        minOrderSize: market.minOrderSize,
      });
      const slot = status.find((s) => s.tokenId === outcome.tokenId && s.tierIndex === i);
      return {
        maxPrice: plan.maxPrice,
        ready: Boolean(slot?.ready),
        unfillable:
          top.ageMs <= this.config.bookFreshMs &&
          isUnfillable(top.ask, plan.maxPrice, this.tickFor(outcome.tokenId)),
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
      openOrders: this.openOrders.map((o) => ({
        ...o,
        sideLabel:
          o.tokenId === this.market?.teamA.tokenId
            ? (this.market?.teamA.name ?? 'A')
            : o.tokenId === this.market?.teamB.tokenId
              ? (this.market?.teamB.name ?? 'B')
              : 'other market',
      })),
      maxRestingPrice: this.market ? maxRestingPrice(this.tickFor(this.market.teamA.tokenId)) : null,
      lastAction: this.lastAction,
      inventory: this.inventory,
      watched: this.watcher.list(),
      watchStatus: this.watcher.status(),
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
    if (this.openOrdersTimer) clearInterval(this.openOrdersTimer);
    this.openOrdersTimer = null;
    if (this.inventoryTimer) clearInterval(this.inventoryTimer);
    this.inventoryTimer = null;
    this.watcher.stop();
    this.presign.close();
    this.book.close();
    this.fills.close();
    this.warmer.stop();
  }
}
