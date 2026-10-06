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
import { FloorOrderCache, floorCap, type FloorTarget } from './floorBuy.ts';
import { ConnectionWarmer } from './warmth.ts';
import { dispatch, type ExecutionResult } from './executor.ts';
import { fetchPositions, type HeldPosition } from './positions.ts';
import { ActivityWatcher, type WatchedTrade } from './watcher.ts';
import { planBuy, planSell, isUnfillable } from './sizing.ts';
import {
  placeLimitSell,
  placeLimitBuy,
  listOpenOrders,
  cancelOrder,
  cancelAllOrders,
  maxRestingPrice,
  clampPrice,
  sellableShares,
  isInsufficientBalanceError,
  type OpenOrder,
} from './limitOrders.ts';
import { resolveEvent, defaultMarket, type ArmableMarket, type ResolvedEvent } from './market.ts';
import { validateFloorBuy, type TradingConfig } from './config.ts';

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
  /**
   * The near-free buy. Independent of the book on purpose: it is for exactly
   * the one-sided book that leaves bid/ask null above. `declined` says why it
   * cannot price on this market's tick.
   */
  floor: { maxPrice: number | null; ready: boolean; declined?: string };
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

/** Longer than FillFeed's 5s order-id race buffer and the observed API lag. */
const POSITION_RECONCILE_MS = 6_500;
const POSITION_RECONCILE_SAFE_AGE_MS = 7_000;

/**
 * The only price the "sell at 99.9c" action will use. Never rounded down to
 * 0.99 — that is a different trade, and he wants it declined instead.
 */
const TARGET_MAX_PRICE = 0.999;

/**
 * Elapsed label for a standing order. A slow one decomposes into its two
 * phases, because they are different problems: `sign` is the SDK's signing
 * endpoint (a network round trip, ~334ms warm / ~1,886ms cold — standing
 * orders have no presign cache), `post` is the venue. Without the split, a
 * cold signature reads as "the venue took 2 seconds", which is what actually
 * scared him.
 */
function elapsedLabel(totalMs: number, signMs?: number, postMs?: number): string {
  const slow = totalMs >= 1_000 && signMs !== undefined && postMs !== undefined;
  return slow ? `${totalMs}ms (sign ${signMs} + post ${postMs})` : `${totalMs}ms`;
}

/** Press-to-fill duration: ms under 10s, then seconds/minutes. */
function sinceLabel(ms: number): string {
  if (ms < 10_000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

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
  floor: { maxPrice: null, ready: false },
};

export class Session extends EventEmitter {
  private book = new BookFeed();
  private fills: FillFeed;
  private presign: PresignCache;
  private floor: FloorOrderCache;
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
  /** Do not let a transient websocket interpretation own sell sizing forever. */
  private lastFillAt = new Map<string, number>();
  private positionGeneration = new Map<string, number>();
  private positionReconcileTimers = new Map<string, NodeJS.Timeout>();
  private watcher: ActivityWatcher;

  constructor(
    private readonly client: any,
    private readonly wallet: string,
    private config: TradingConfig,
  ) {
    super();
    this.fills = new FillFeed(client);
    this.presign = new PresignCache(client, this.book, { driftToleranceTicks: 1 });
    this.floor = new FloorOrderCache(client);
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
      this.markPositionActivity(f.tokenId);
      this.schedulePositionReconcile(f.tokenId);
      // A partial maker sell changes how many shares remain reserved. Refresh
      // immediately so another sell-all does not subtract the stale full order.
      if (f.side === 'SELL') void this.refreshOpenOrders();
      const which = f.tokenId === this.market?.teamA.tokenId ? 'A' : 'B';
      // press->fill is the "signal to fill" number he asked for: keypress to
      // this confirmation arriving. Absent on fills we did not originate.
      this.push(
        'fill',
        `${f.side} ${f.size} ${which} @ ${f.price}${f.inverted ? ' (inverted)' : ''}` +
          `${f.sincePressMs !== null ? `  press→fill ${sinceLabel(f.sincePressMs)}` : ''}`,
      );
    });
    // A maker event can beat postOrder() and therefore arrive before its order
    // id is known. FillFeed buffers it; REST reconciliation is the backstop for
    // orders placed outside this app or an event that cannot be attributed.
    this.fills.on('reconcile', (tokenId: string) => {
      if (tokenId) {
        // Prevent the periodic REST poll from seeding an absolute position
        // while a buffered websocket delta is still waiting for its order id.
        this.markPositionActivity(tokenId);
        this.schedulePositionReconcile(tokenId);
      }
    });
    this.fills.on('position', () => this.emit('update'));
    this.presign.on('ready', () => this.emit('update'));
    this.presign.on('error', (e) => this.push('warn', `presign: ${e.message}`));
    this.floor.on('ready', () => this.emit('update'));
    this.floor.on('error', (e) => this.push('warn', `near-free presign: ${e.message}`));
    // The first snapshot can bring a different tick than Gamma reported at arm
    // time, and the near-free cap is priced on the tick. A comparison when
    // nothing changed, so cheap enough for every update.
    this.book.on('update', () => this.syncFloor());
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
    this.syncFloor();
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

  private floorTarget(side: 'A' | 'B'): FloorTarget {
    const outcome = side === 'A' ? this.market!.teamA : this.market!.teamB;
    return {
      tokenId: outcome.tokenId,
      tickSize: this.tickFor(outcome.tokenId),
      notional: this.config.floorBuyNotional,
      capCents: this.config.floorBuyCapCents,
    };
  }

  /** Keep both near-free buys signed for the current market, amount and tick. */
  private syncFloor(): void {
    if (!this.market) return;
    // Don't load an order a press would refuse anyway.
    if (validateFloorBuy(this.config)) return;
    this.floor.sync([this.floorTarget('A'), this.floorTarget('B')]);
  }

  private async armMarket(market: ArmableMarket): Promise<void> {
    this.market = market;
    const tokens = [market.teamA.tokenId, market.teamB.tokenId];

    this.book.subscribe(tokens);
    this.fills.watch(tokens);
    // Needs no book, so load it now rather than after waitForBook — the
    // one-sided book it exists for may never satisfy that wait.
    this.floor.reset();
    this.syncFloor();

    // Seed from the Data API: the user channel only reports fills that happen
    // while connected, so without this a sell hotkey thinks he is flat.
    try {
      const held = await fetchPositions(this.wallet);
      for (const tokenId of tokens) this.seedPosition(held, tokenId);
      // The Data API was observed lagging a fresh fill by >2.5s. Re-read after
      // that window instead of letting an arm-time zero remain authoritative.
      for (const tokenId of tokens) this.schedulePositionReconcile(tokenId);
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

  private seedPosition(held: Map<string, HeldPosition>, tokenId: string): void {
    const p = held.get(tokenId);
    this.fills.seed(tokenId, p?.shares ?? 0, p?.avgPrice ?? 0);
  }

  private markPositionActivity(tokenId: string): void {
    this.lastFillAt.set(tokenId, Date.now());
    this.positionGeneration.set(tokenId, (this.positionGeneration.get(tokenId) ?? 0) + 1);
  }

  /** Reconcile after the Data API's observed lag window, coalesced per token. */
  private schedulePositionReconcile(tokenId: string): void {
    const prior = this.positionReconcileTimers.get(tokenId);
    if (prior) clearTimeout(prior);
    const fillGeneration = this.positionGeneration.get(tokenId) ?? 0;
    const timer = setTimeout(() => {
      this.positionReconcileTimers.delete(tokenId);
      void this.reconcilePosition(tokenId, fillGeneration).catch(() => {
        /* periodic inventory refresh is the next retry */
      });
    }, POSITION_RECONCILE_MS);
    timer.unref?.();
    this.positionReconcileTimers.set(tokenId, timer);
  }

  private async reconcilePosition(tokenId: string, fillGeneration: number): Promise<number> {
    const held = await fetchPositions(this.wallet);
    // A newer websocket fill landed while this request was in flight. Its
    // in-memory result is newer than this REST response; its own timer will
    // reconcile later.
    if ((this.positionGeneration.get(tokenId) ?? 0) !== fillGeneration) {
      return this.fills.position(tokenId).shares;
    }
    this.seedPosition(held, tokenId);
    return held.get(tokenId)?.shares ?? 0;
  }

  /**
   * An insufficient-balance rejection means our fast local ledger or resting
   * order snapshot is wrong. Re-read both authorities through the Data API's
   * lag window, then let the caller retry once with the actual maximum.
   */
  private async recoverSellableShares(tokenId: string, attempted: number): Promise<number> {
    let latest = 0;
    for (const delay of [0, 400, 900, 1_600, 2_500]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      await this.refreshOpenOrders();
      try {
        const fillGeneration = this.positionGeneration.get(tokenId) ?? 0;
        const held = await fetchPositions(this.wallet);
        if ((this.positionGeneration.get(tokenId) ?? 0) !== fillGeneration) continue;
        this.seedPosition(held, tokenId);
        latest = sellableShares(held.get(tokenId)?.shares ?? 0, this.openOrders, tokenId);
        if (latest > 0 && Math.abs(latest - attempted) > 1e-6) return latest;
      } catch {
        /* try the next backoff step */
      }
    }
    return latest;
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
      const available = sellableShares(position.shares, this.openOrders, outcome.tokenId);
      if (available <= 0) {
        this.stamp(
          label,
          'blocked',
          null,
          position.shares > 0 ? 'all shares are already resting' : 'no position to sell',
        );
        this.push(
          'warn',
          position.shares > 0
            ? `all ${position.shares} ${outcome.name} shares are already resting`
            : `no ${outcome.name} position to sell`,
        );
        return null;
      }
      const plan = planSell({
        shares: available,
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
        const result = await this.send(
          order,
          'SELL',
          outcome.tokenId,
          `SELL ${plan.shares} ${outcome.name} floor ${plan.minPrice}`,
          started,
        );
        if (
          result?.verdict === 'rejected' &&
          isInsufficientBalanceError(result.error)
        ) {
          const recovered = await this.recoverSellableShares(outcome.tokenId, plan.shares);
          if (
            recovered >= market.minOrderSize &&
            Math.abs(recovered - plan.shares) > 1e-6
          ) {
            this.push(
              'warn',
              `sellable balance is ${recovered}, not ${plan.shares} — retrying SELL ALL once`,
            );
            const retryPlan = planSell({
              shares: recovered,
              bestBid: top.bid,
              slippageCents: this.config.sellSlippageCents,
              tickSize: this.tickFor(outcome.tokenId),
              minOrderSize: market.minOrderSize,
            });
            const retryOrder = await this.client.createMarketOrder({
              tokenId: outcome.tokenId,
              side: OrderSide.SELL,
              shares: retryPlan.shares,
              minPrice: retryPlan.minPrice,
              orderType: OrderType.FAK,
            });
            return await this.send(
              retryOrder,
              'SELL',
              outcome.tokenId,
              `SELL ${retryPlan.shares} ${outcome.name} floor ${retryPlan.minPrice}`,
              Date.now(),
            );
          }
        }
        return result;
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

  /**
   * Buy at or under the near-free cap (keys 2 / 5) — see floorBuy.ts.
   *
   * No book check, deliberately: the late-game book this is for has offers
   * and no bids, which top() reads as no book at all. The cents cap bounds the
   * price instead, and an order with nothing offered under it is killed free.
   * FAK like the other buys — whatever is not there now is not left resting.
   */
  async buyAtFloor(side: 'A' | 'B'): Promise<ExecutionResult | null> {
    const label = `NEAR-FREE ${side}`;
    const market = this.market;
    if (!market) {
      this.stamp(label, 'blocked', null, 'no market armed');
      this.push('warn', 'no market armed');
      return null;
    }
    const outcome = side === 'A' ? market.teamA : market.teamB;

    const problem = validateFloorBuy(this.config);
    if (problem) {
      this.stamp(label, 'blocked', null, problem);
      this.push('error', `near-free buy refused: ${problem}`);
      return null;
    }

    const target = this.floorTarget(side);
    const { maxPrice, declined } = floorCap(target.capCents, target.tickSize);
    if (maxPrice === null) {
      this.stamp(label, 'blocked', null, declined);
      this.push('warn', `near-free buy declined: ${declined}`);
      return null;
    }

    const started = Date.now();
    let ready;
    try {
      ready = await this.floor.take(target);
    } catch (err: any) {
      this.stamp(label, 'blocked', null, 'could not sign an order');
      this.push('error', `could not sign the near-free buy: ${err?.message ?? err}`);
      return null;
    }
    if (!ready) {
      this.stamp(label, 'blocked', null, 'could not sign an order');
      this.push('error', 'could not obtain a signed near-free order');
      return null;
    }
    if (!ready.presigned) this.push('warn', `near-free buy signed inline (${ready.signMs}ms)`);
    return this.send(
      ready.order,
      'BUY',
      outcome.tokenId,
      `NEAR-FREE BUY $${ready.notional} ${outcome.name} cap ${ready.maxPrice}`,
      started,
    );
  }

  // --- standing (GTC) sell orders ------------------------------------------
  //
  // These REST on the book until filled or cancelled, unlike every other order
  // this app sends. He gets four ways to price a sell: an exact price he types,
  // the current ask (capturing the spread instead of crossing it), a little
  // under the bid (takes what is there, rests the remainder), and the highest
  // price the market allows (a near-resolution exit). Plus one standing buy,
  // resting at the bid.

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
   * Sell the position at 99.9c — and ONLY at 99.9c.
   *
   * Markets start on a 0.01 tick and move to 0.001 as they mature, so 0.999 is
   * not always placeable. Falling back to 0.99 would be a materially different
   * trade (a whole cent per share) made silently on his behalf, so when the
   * market cannot take 0.999 this declines and says why.
   */
  async sellAtMax(side: 'A' | 'B'): Promise<void> {
    const market = this.market;
    if (!market) {
      this.stamp(`SELL ${side} @ 99.9c`, 'blocked', null, 'no market armed');
      return;
    }
    const outcome = side === 'A' ? market.teamA : market.teamB;
    const tick = this.tickFor(outcome.tokenId);
    const best = maxRestingPrice(tick);

    if (best < TARGET_MAX_PRICE - 1e-9) {
      const detail = `this market's tick is ${tick} — the best it allows is ${best}, not 0.999`;
      this.stamp(`SELL ${side} @ 99.9c`, 'blocked', null, detail);
      this.push('warn', `99.9c declined: ${detail}. Ticks usually tighten later in a match.`);
      return;
    }
    return this.placeStandingSell(side, TARGET_MAX_PRICE, 'at 0.999');
  }

  /**
   * Sell the whole position a little UNDER the bid, as a standing order.
   *
   * Priced through the bid it crosses immediately: whatever the bid side can
   * absorb fills at once (at the bid — the venue price-improves), and the
   * remainder stays on the book at bid minus the offset instead of being
   * killed. That is the difference from SELL ALL NOW, which is FAK.
   *
   * The offset is literal cents (config.sellBelowBidCents), rounded to the tick.
   */
  async sellBelowBid(side: 'A' | 'B'): Promise<void> {
    const market = this.market;
    if (!market) {
      this.stamp(`SELL ${side} < BID`, 'blocked', null, 'no market armed');
      this.push('warn', 'no market armed');
      return;
    }
    const outcome = side === 'A' ? market.teamA : market.teamB;
    const top = this.book.top(outcome.tokenId);
    if (!top) {
      this.stamp(`SELL ${side} < BID`, 'blocked', null, 'no book');
      this.push('error', `no book for ${outcome.name}`);
      return;
    }
    const offset = this.config.sellBelowBidCents / 100;
    const price = Number((top.bid - offset).toFixed(4));
    return this.placeStandingSell(side, price, `${this.config.sellBelowBidCents}c under the bid (${top.bid})`);
  }

  /**
   * Rest a fixed-dollar BUY at the current bid.
   *
   * Joins the bid queue as a maker rather than lifting the offer: it only fills
   * if someone sells into it, and it is exempt from the venue's ~250ms
   * marketable hold. Sized in shares from config.limitBuyNotional at the bid.
   *
   * Not double-press guarded, same as the FAK buys — stacking a second clip is
   * legitimate, and Cancel all covers a mistake.
   */
  async buyAtBid(side: 'A' | 'B'): Promise<void> {
    const label = `LIMIT BUY ${side} @ BID`;
    const market = this.market;
    if (!market) {
      this.stamp(label, 'blocked', null, 'no market armed');
      this.push('warn', 'no market armed');
      return;
    }
    const outcome = side === 'A' ? market.teamA : market.teamB;
    const top = this.book.top(outcome.tokenId);
    if (!top) {
      this.stamp(label, 'blocked', null, 'no book');
      this.push('error', `no book for ${outcome.name} — refusing to trade blind`);
      return;
    }

    const notional = this.config.limitBuyNotional;
    if (!(notional > 0) || notional > this.config.maxNotionalPerOrder) {
      const detail = `$${notional} is outside the 0–${this.config.maxNotionalPerOrder} cap`;
      this.stamp(label, 'blocked', null, detail);
      this.push('error', `limit buy refused: ${detail}`);
      return;
    }

    const tick = this.tickFor(outcome.tokenId);
    const preview = clampPrice(top.bid, tick);
    if (this.config.dryRun) {
      this.stamp(`LIMIT BUY ${side} @ ${preview.price}`, 'dry', null);
      this.push('info', `DRY RUN: standing BUY $${notional} ${outcome.name} at the bid -> ${preview.price}`);
      return;
    }

    const started = Date.now();
    const result = await placeLimitBuy(this.client, {
      tokenId: outcome.tokenId,
      notional,
      price: top.bid,
      tickSize: tick,
      minOrderSize: market.minOrderSize,
    });
    const elapsed = Date.now() - started;

    if (!result.ok) {
      this.stamp(label, 'blocked', elapsed, result.error);
      this.push(
        'error',
        `standing BUY $${notional} ${outcome.name} at the bid rejected: ${result.error}  ${elapsedLabel(elapsed, result.signMs, result.postMs)}`,
      );
    } else {
      this.stamp(`LIMIT BUY ${side} @ ${result.price}`, 'sent', elapsed);
      this.push(
        'fill',
        `standing BUY ${result.shares} ${outcome.name} @ ${result.price} ($${notional}) resting` +
          `${result.adjusted ? ` (${result.adjusted})` : ''}  ${elapsedLabel(elapsed, result.signMs, result.postMs)}`,
      );
      if (result.orderId) this.fills.expectOrder(result.orderId, outcome.tokenId, 'BUY', started);
    }
    await this.refreshOpenOrders();
  }

  private async placeStandingSell(
    side: 'A' | 'B',
    price: number,
    describe: string,
  ): Promise<void> {
    const market = this.market;
    if (!market) return this.placeStandingSellUnchecked(side, price, describe);
    const tokenId = (side === 'A' ? market.teamA : market.teamB).tokenId;
    if (this.sellInFlight.has(tokenId)) {
      this.stamp(`LIMIT SELL ${side}`, 'blocked', null, 'a sell is already in flight');
      this.push('warn', `sell already in flight for ${side} — ignored`);
      return;
    }
    this.sellInFlight.add(tokenId);
    try {
      await this.placeStandingSellUnchecked(side, price, describe);
    } finally {
      this.sellInFlight.delete(tokenId);
    }
  }

  private async placeStandingSellUnchecked(
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
    let available = sellableShares(position.shares, this.openOrders, outcome.tokenId);

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

    const pressedAt = Date.now();
    let started = pressedAt;
    let result = await placeLimitSell(this.client, {
      tokenId: outcome.tokenId,
      shares: available,
      price,
      tickSize: this.tickFor(outcome.tokenId),
      minOrderSize: market.minOrderSize,
    });
    let elapsed = Date.now() - started;

    if (!result.ok && isInsufficientBalanceError(result.error)) {
      const recovered = await this.recoverSellableShares(outcome.tokenId, available);
      if (
        recovered >= market.minOrderSize &&
        Math.abs(recovered - available) > 1e-6
      ) {
        this.push(
          'warn',
          `sellable balance is ${recovered}, not ${available} — retrying LIMIT SELL once`,
        );
        available = recovered;
        started = Date.now();
        result = await placeLimitSell(this.client, {
          tokenId: outcome.tokenId,
          shares: available,
          price,
          tickSize: this.tickFor(outcome.tokenId),
          minOrderSize: market.minOrderSize,
        });
        elapsed = Date.now() - started;
      }
    }

    if (!result.ok) {
      this.stamp(`LIMIT SELL ${side}`, 'blocked', elapsed, result.error);
      this.push(
        'error',
        `standing SELL ${describe} rejected: ${result.error}  ${elapsedLabel(elapsed, result.signMs, result.postMs)}`,
      );
    } else {
      this.stamp(`LIMIT SELL ${side} @ ${result.price}`, 'sent', elapsed);
      this.push(
        'fill',
        `standing SELL ${result.shares} ${outcome.name} @ ${result.price} resting` +
          `${result.adjusted ? ` (${result.adjusted})` : ''}  ${elapsedLabel(elapsed, result.signMs, result.postMs)}`,
      );
      if (result.orderId) this.fills.expectOrder(result.orderId, outcome.tokenId, 'SELL', pressedAt);
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
      // The websocket ledger is the low-latency path; the Data API is the
      // authority once its lag window has passed. This repairs any missed or
      // unattributable fill instead of leaving every future sell poisoned.
      if (this.market) {
        for (const tokenId of [this.market.teamA.tokenId, this.market.teamB.tokenId]) {
          const lastFill = this.lastFillAt.get(tokenId) ?? 0;
          if (Date.now() - lastFill >= POSITION_RECONCILE_SAFE_AGE_MS) {
            this.seedPosition(held, tokenId);
          }
        }
      }
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
      // Orders can survive an app restart or be placed from Polymarket's UI.
      // Register the authoritative list so their later maker fills use the
      // maker leg too, not the aggregate taker trade.
      for (const order of this.openOrders) {
        if (order.orderId && order.tokenId) {
          this.fills.expectOrder(order.orderId, order.tokenId, order.side);
        }
      }
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
    const endTakerPost = this.fills.beginTakerPost();
    let result: ExecutionResult;
    try {
      result = await dispatch(this.client, order, side);
      // Register before releasing buffered taker events, so a merge match is
      // attributed to the token and side we actually sent. The response's fill
      // goes on the position immediately (see FillFeed.expectOrder): he must
      // be able to sell what he just bought without waiting ~0.65-2s for the
      // websocket to say so.
      if (result.orderId) {
        const provisional =
          result.filledShares > 0 && result.avgPrice !== null
            ? { shares: result.filledShares, price: result.avgPrice }
            : undefined;
        this.fills.expectOrder(result.orderId, tokenId, side, startedAt, provisional);
        if (provisional) {
          // Same bookkeeping a fill event gets: shields the fresh position
          // from the lagging Data API poll and books the authoritative check.
          this.markPositionActivity(tokenId);
          this.schedulePositionReconcile(tokenId);
        }
      }
    } finally {
      endTakerPost();
    }

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
        `${describe} -> ${result.filledShares} sh @ ${result.avgPrice}  ${total}ms`,
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

    const floorTarget = this.floorTarget(which);
    const floorPrice = floorCap(floorTarget.capCents, floorTarget.tickSize);

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
      floor: {
        maxPrice: floorPrice.maxPrice,
        ready: this.floor.isReady(floorTarget),
        declined: floorPrice.declined,
      },
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

  /**
   * Diagnostics from outside the session (main-process stalls, HUD freezes)
   * go through here so they sit in the same buffer as the trading log — the
   * one "Copy log" exports, which is what he sends when something misbehaves.
   */
  note(level: LogEntry['level'], text: string): void {
    this.push(level, text);
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
    for (const timer of this.positionReconcileTimers.values()) clearTimeout(timer);
    this.positionReconcileTimers.clear();
    this.watcher.stop();
    this.presign.close();
    this.floor.reset();
    this.book.close();
    this.fills.close();
    this.warmer.stop();
  }
}
