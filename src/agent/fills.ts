/**
 * User channel: live fills and position tracking.
 *
 * Two things from bill_sheng_code shape this file, both learned in production:
 *
 * 1. THE PRICE INVERSION TRAP (order.rs:1084-1095). Polymarket can match a BUY
 *    of token A against a BUY of the complementary token B — a "merge" match.
 *    When that happens the trade's price is quoted from the COUNTERPARTY's
 *    side, so our true fill price is `1 - price`. Their handoff records the
 *    symptom (AI_HANDOFF.md:992): a raw response implying 0.35 while the local
 *    log said 0.65. Showing him an inverted fill price on a live trade would be
 *    worse than showing nothing.
 *
 * 2. FAK KILLS ARE SILENT (AI_HANDOFF.md:130). Proven live — 4 kills and 2
 *    fills produced zero order-channel events for the kills. So this stream can
 *    confirm a fill but can NEVER confirm a miss. The POST response is the
 *    authority on whether an order died; this channel is the fast path for
 *    fills and the only way to see fills we did not originate.
 */

import { EventEmitter } from 'node:events';

/** A normalized fill, already corrected for the inversion trap. */
export interface Fill {
  tradeId: string;
  /** Our order id — takerOrderId for takers, makerOrders[].orderId for makers. */
  orderId: string;
  /** The token WE traded, not necessarily the token the event is keyed on. */
  tokenId: string;
  /** Our true price per share, inverted where the venue merged across tokens. */
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  /** True when the raw price was quoted from the counterparty's side. */
  inverted: boolean;
  receivedAt: number;
  /**
   * Milliseconds from the keypress that placed the order to this confirmation
   * arriving — the "signal to fill" he actually cares about. Null when the fill
   * cannot be attributed to a press of ours (an order placed from the web UI,
   * or an event taken at face value without an order record).
   */
  sincePressMs: number | null;
}

export interface Position {
  tokenId: string;
  /** Net shares held. */
  shares: number;
  /** Average entry price across accumulated buys. */
  avgPrice: number;
  /** Total dollars spent net of sale proceeds. */
  costBasis: number;
}

type SubscriptionHandle = AsyncIterable<unknown> & { close?: () => void };
interface SubscribingClient {
  subscribe(specs: readonly { topic: string }[]): Promise<SubscriptionHandle>;
}

interface ExpectedOrder {
  tokenId: string;
  side: 'BUY' | 'SELL';
  /** When the key was pressed, so the fill event can report press-to-fill. */
  pressedAt?: number;
  /**
   * Shares already applied to the position from the POST response and still
   * awaiting their websocket confirmation. Each fill event for this order
   * consumes from here before touching the position again, so the same shares
   * are never counted twice.
   */
  provisional?: number;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Emits:
 *   'fill'     (fill: Fill)            — a confirmed match involving us
 *   'position' (position: Position)    — running position for a token
 *   'status'   (up: boolean)
 *   'error'    (err: Error)
 */
export class FillFeed extends EventEmitter {
  private positions = new Map<string, Position>();
  /** (tradeId:orderId) already applied — the venue re-pushes on chain confirmation. */
  private seen = new Set<string>();
  /** Tokens we care about; anything else is another market's noise. */
  private watched = new Set<string>();
  /**
   * orderId -> the token we actually ordered.
   *
   * This is what makes merge detection reliable. Watching both legs of a binary
   * market means a merge match keyed on Team A is indistinguishable from a real
   * Team A trade by inspection alone — but we know what we sent.
   */
  private ourOrders = new Map<string, ExpectedOrder>();
  /**
   * A very fast fill can beat the POST response carrying its order id. Hold
   * those events briefly so expectOrder() can replay them once the id is known
   * instead of applying an ambiguous venue event to our position.
   */
  private pendingEvents: {
    event: Record<string, any>;
    queuedAt: number;
    timer: NodeJS.Timeout;
  }[] = [];
  private takerPostsInFlight = 0;
  private handle: SubscriptionHandle | null = null;
  private stopped = false;
  private up = false;

  constructor(
    private readonly client: SubscribingClient,
    private readonly pendingEventMs = 5_000,
  ) {
    super();
  }

  /** Limit attention to the armed market's two tokens. */
  watch(tokenIds: string[]): void {
    this.watched = new Set(tokenIds);
  }

  /**
   * Record an order we just sent, so its fill can be attributed to the right
   * token even when the venue keys the trade on the complementary one.
   * Call this as soon as a POST returns an order id.
   */
  expectOrder(
    orderId: string,
    tokenId: string,
    side: 'BUY' | 'SELL',
    pressedAt?: number,
    provisional?: { shares: number; price: number },
  ): void {
    if (!orderId) return;
    const expected: ExpectedOrder = { tokenId, side, pressedAt };

    // A FAK's POST response is the authority on its fill (the websocket cannot
    // even report a kill), and it arrives ~100ms after the press. The
    // confirmation event trails it by ~0.65s median and sometimes 2s+, and
    // until it landed the sell keys read "no position". So the response's fill
    // is applied NOW and the later event only confirms it. Recorded before the
    // replay below, so a confirmation that beat the response nets correctly.
    if (provisional && provisional.shares > 0 && this.watched.has(tokenId)) {
      expected.provisional = provisional.shares;
      this.applyToPosition({ tokenId, side, size: provisional.shares, price: provisional.price });
    }
    this.ourOrders.set(orderId, expected);
    if (this.ourOrders.size > 500) {
      this.ourOrders = new Map([...this.ourOrders].slice(-250));
    }

    // The websocket can win the race against postOrder(). Replay any maker
    // event that carried this id before the response made it back to us.
    const pending = this.pendingEvents;
    this.pendingEvents = pending.filter((item) => {
      const { event } = item;
      const takerMatches = String(event?.payload?.takerOrderId ?? '') === orderId;
      const makers = Array.isArray(event?.payload?.makerOrders)
        ? event.payload.makerOrders as Record<string, any>[]
        : [];
      const matches = takerMatches || makers.some((m) => String(m?.orderId ?? '') === orderId);
      if (matches) {
        clearTimeout(item.timer);
        this.onEvent(event, true);
      }
      return !matches;
    });
  }

  /**
   * Mark the narrow window in which an unknown taker event may be ours but the
   * POST has not returned its order id yet. External web-UI taker fills retain
   * the original immediate fallback when no app POST is active.
   */
  beginTakerPost(): () => void {
    this.takerPostsInFlight += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.takerPostsInFlight = Math.max(0, this.takerPostsInFlight - 1);
      if (this.takerPostsInFlight === 0) this.flushPendingTakers();
    };
  }

  /** Seed positions from an authoritative source (REST) before streaming. */
  seed(tokenId: string, shares: number, avgPrice: number): void {
    this.positions.set(tokenId, {
      tokenId,
      shares,
      avgPrice,
      costBasis: shares * avgPrice,
    });
    this.emit('position', this.positions.get(tokenId)!);
  }

  position(tokenId: string): Position {
    return (
      this.positions.get(tokenId) ?? { tokenId, shares: 0, avgPrice: 0, costBasis: 0 }
    );
  }

  isUp(): boolean {
    return this.up;
  }

  async start(): Promise<void> {
    this.stopped = false;
    void this.runLoop();
  }

  close(): void {
    this.stopped = true;
    this.handle?.close?.();
    this.handle = null;
    for (const pending of this.pendingEvents) clearTimeout(pending.timer);
    this.pendingEvents = [];
    this.takerPostsInFlight = 0;
    this.setUp(false);
  }

  private setUp(next: boolean): void {
    if (this.up === next) return;
    this.up = next;
    this.emit('status', next);
  }

  /** Reconnect forever with backoff — a dropped fill feed must self-heal. */
  private async runLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        const handle = await this.client.subscribe([{ topic: 'user' }]);
        this.handle = handle;
        this.setUp(true);
        attempt = 0;
        for await (const event of handle) {
          if (this.stopped) break;
          this.onEvent(event as Record<string, any>);
        }
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
      this.setUp(false);
      if (this.stopped) break;
      const delay = Math.min(250 * 2 ** attempt, 5_000);
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private onEvent(event: Record<string, any>, replayed = false): void {
    if (event?.topic !== 'user' || event?.type !== 'trade') return;
    const p = event.payload as Record<string, any> | undefined;
    if (!p) return;

    // Only MATCHED is a new fill. MINED/CONFIRMED are on-chain echoes of a
    // trade we have already counted (order.rs:1041) — all three carry the same
    // trade id, so counting them would triple every position.
    //
    // The venue sends `TRADE_STATUS_MATCHED`, not `MATCHED`. Matching the bare
    // word dropped every fill silently; suffix-match tolerates both forms.
    const status = String(p.status ?? '').toUpperCase();
    if (!status.endsWith('MATCHED')) return;

    const orderId = String(p.takerOrderId ?? '');
    const tradeId = String(p.id ?? '');
    if (!tradeId) return;

    const eventToken = String(p.tokenId ?? '');
    const rawPrice = num(p.price);
    const size = num(p.size);
    if (size <= 0 || rawPrice <= 0) return;

    // A user trade event describes the TAKER at the top level. For a standing
    // sell we are the MAKER, and our side/size/price are inside makerOrders.
    // One real incident was top-level BUY 1135 while our maker leg was SELL
    // 606; applying the top level invented 1135 shares in the local position.
    const makers: Record<string, any>[] = Array.isArray(p.makerOrders) ? p.makerOrders : [];
    const ourMakerLegs = makers.flatMap((maker) => {
      const makerOrderId = String(maker?.orderId ?? '');
      const expected = this.ourOrders.get(makerOrderId);
      return expected ? [{ maker, makerOrderId, expected }] : [];
    });

    if (ourMakerLegs.length > 0) {
      for (const { maker, makerOrderId, expected } of ourMakerLegs) {
        const makerToken = String(maker?.tokenId ?? '');
        const makerPrice = num(maker?.price);
        const makerSize = num(maker?.matchedAmount);
        if (!this.watched.has(expected.tokenId) || makerPrice <= 0 || makerSize <= 0) continue;
        const inverted = Boolean(makerToken) && makerToken !== expected.tokenId;
        this.applyFill({
          tradeId,
          orderId: makerOrderId,
          tokenId: expected.tokenId,
          price: inverted ? Number((1 - makerPrice).toFixed(6)) : makerPrice,
          size: makerSize,
          side: expected.side,
          inverted,
          receivedAt: Date.now(),
          sincePressMs: expected.pressedAt ? Date.now() - expected.pressedAt : null,
        });
      }
      return;
    }

    // traderSide is supplied by the SDK specifically to say which role this
    // account played. Never fall back to the taker's BUY for an unknown maker:
    // wait for expectOrder(), or let the REST reconciliation repair a maker
    // order placed outside this app.
    if (String(p.traderSide ?? '').toUpperCase() === 'MAKER') {
      if (!replayed) {
        this.queuePending(event, tradeId);
        const possibleTokens = new Set(
          makers
            .map((m) => String(m?.tokenId ?? ''))
            .filter((tokenId) => this.watched.has(tokenId)),
        );
        if (possibleTokens.size === 0 && this.watched.has(eventToken)) {
          possibleTokens.add(eventToken);
        }
        for (const tokenId of possibleTokens) this.emit('reconcile', tokenId);
      }
      return;
    }

    // Taker order: the event may be keyed on the complementary token, so the
    // token and side we recorded at dispatch remain authoritative.
    const expectedTaker = this.ourOrders.get(orderId);
    if (
      !expectedTaker &&
      String(p.traderSide ?? '').toUpperCase() === 'TAKER' &&
      !replayed &&
      this.takerPostsInFlight > 0
    ) {
      this.queuePending(event, tradeId);
      this.emit('reconcile', eventToken);
      return;
    }
    let ourToken: string;
    let inverted: boolean;
    let side: 'BUY' | 'SELL';
    let sincePressMs: number | null = null;

    if (expectedTaker) {
      // Authoritative: we sent this order and know its token.
      ourToken = expectedTaker.tokenId;
      side = expectedTaker.side;
      inverted = expectedTaker.tokenId !== eventToken;
      if (expectedTaker.pressedAt) sincePressMs = Date.now() - expectedTaker.pressedAt;
    } else if (this.watched.has(eventToken)) {
      // A fill we did not originate (placed from the web UI, say). Take the
      // event at face value — with no order of ours to compare against there is
      // nothing that reliably distinguishes a merge from a direct match.
      ourToken = eventToken;
      side = String(p.side ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
      inverted = false;
    } else {
      // Not keyed on anything we watch; salvage it only if one of our tokens
      // appears on the maker side, which means the trade is quoted against the
      // complementary outcome.
      const ourLeg = makers.find((m) => this.watched.has(String(m?.tokenId ?? '')));
      if (!ourLeg) return; // genuinely not our market
      ourToken = String(ourLeg.tokenId);
      side = String(p.side ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
      inverted = true;
    }
    if (!this.watched.has(ourToken)) return;

    // The correction from order.rs:1095: a price quoted against the
    // complementary token is worth (1 - price) from our side.
    const price = inverted ? Number((1 - rawPrice).toFixed(6)) : rawPrice;

    this.applyFill({
      tradeId,
      orderId,
      tokenId: ourToken,
      price,
      size,
      side,
      inverted,
      receivedAt: Date.now(),
      sincePressMs,
    });
  }

  private queuePending(event: Record<string, any>, tradeId: string): void {
    const cutoff = Date.now() - 5_000;
    const expired = this.pendingEvents.filter((x) => x.queuedAt < cutoff);
    for (const item of expired) clearTimeout(item.timer);
    this.pendingEvents = this.pendingEvents.filter((x) => x.queuedAt >= cutoff);
    while (this.pendingEvents.length >= 50) {
      const dropped = this.pendingEvents.shift();
      if (dropped) clearTimeout(dropped.timer);
    }
    if (!this.pendingEvents.some((x) => x.event?.payload?.id === tradeId)) {
      const timer = setTimeout(() => {
        this.pendingEvents = this.pendingEvents.filter((x) => x.event !== event);
        // For a taker order placed outside this app, preserve the original
        // honest fallback after giving postOrder() time to provide an id. A
        // maker event can never use the taker's top-level side/size safely.
        this.onEvent(event, true);
      }, this.pendingEventMs);
      timer.unref?.();
      this.pendingEvents.push({ event, queuedAt: Date.now(), timer });
    }
  }

  private flushPendingTakers(): void {
    const pending = this.pendingEvents;
    this.pendingEvents = pending.filter((item) => {
      const isTaker = String(item.event?.payload?.traderSide ?? '').toUpperCase() === 'TAKER';
      if (isTaker) {
        clearTimeout(item.timer);
        this.onEvent(item.event, true);
      }
      return !isTaker;
    });
  }

  private applyFill(fill: Fill): void {
    const dedupeKey = `${fill.tradeId}:${fill.orderId}`;
    if (this.seen.has(dedupeKey)) return;
    this.seen.add(dedupeKey);
    // Unbounded growth over a long session would leak; a match cannot re-arrive
    // after this many later trades.
    if (this.seen.size > 5_000) {
      this.seen = new Set([...this.seen].slice(-2_500));
    }
    // Net against shares the POST response already put on the position. Only
    // whatever exceeds that (a response that under-reported, which has not
    // been observed) still moves the ledger.
    let uncounted = fill.size;
    const expected = this.ourOrders.get(fill.orderId);
    if (expected?.provisional) {
      const covered = Math.min(uncounted, expected.provisional);
      expected.provisional = Number((expected.provisional - covered).toFixed(6));
      uncounted = Number((uncounted - covered).toFixed(6));
    }
    if (uncounted > 0) this.applyToPosition({ ...fill, size: uncounted });
    this.emit('fill', fill);
  }

  private applyToPosition(fill: Pick<Fill, 'tokenId' | 'side' | 'size' | 'price'>): void {
    const current = this.position(fill.tokenId);
    const signed = fill.side === 'BUY' ? fill.size : -fill.size;
    const shares = Number((current.shares + signed).toFixed(6));

    let costBasis: number;
    if (fill.side === 'BUY') {
      costBasis = current.costBasis + fill.size * fill.price;
    } else {
      // Sells retire basis at the running average, leaving avgPrice unchanged.
      costBasis = current.costBasis - fill.size * current.avgPrice;
    }

    const next: Position = {
      tokenId: fill.tokenId,
      shares,
      // Flat means flat: don't carry a stale average into the next position.
      avgPrice: shares > 1e-9 ? Number((costBasis / shares).toFixed(6)) : 0,
      costBasis: shares > 1e-9 ? Number(costBasis.toFixed(6)) : 0,
    };
    this.positions.set(fill.tokenId, next);
    this.emit('position', next);
  }
}
