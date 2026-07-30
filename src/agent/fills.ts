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
  /** Our order id — we are always the taker, so this is `takerOrderId`. */
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
  private ourOrders = new Map<string, string>();
  private handle: SubscriptionHandle | null = null;
  private stopped = false;
  private up = false;

  constructor(private readonly client: SubscribingClient) {
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
  expectOrder(orderId: string, tokenId: string): void {
    if (!orderId) return;
    this.ourOrders.set(orderId, tokenId);
    if (this.ourOrders.size > 500) {
      this.ourOrders = new Map([...this.ourOrders].slice(-250));
    }
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

  private onEvent(event: Record<string, any>): void {
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
    const dedupeKey = `${tradeId}:${orderId}`;
    if (!tradeId || this.seen.has(dedupeKey)) return;

    const eventToken = String(p.tokenId ?? '');
    const rawPrice = num(p.price);
    const size = num(p.size);
    if (size <= 0 || rawPrice <= 0) return;

    // Work out which token WE actually traded. The event is keyed on the
    // trade's token, which for a merge match is the counterparty's side.
    const makers: Record<string, any>[] = Array.isArray(p.makerOrders) ? p.makerOrders : [];
    let ourToken: string;
    let inverted: boolean;

    const ordered = this.ourOrders.get(orderId);
    if (ordered) {
      // Authoritative: we sent this order and know its token.
      ourToken = ordered;
      inverted = ordered !== eventToken;
    } else if (this.watched.has(eventToken)) {
      // A fill we did not originate (placed from the web UI, say). Take the
      // event at face value — with no order of ours to compare against there is
      // nothing that reliably distinguishes a merge from a direct match.
      ourToken = eventToken;
      inverted = false;
    } else {
      // Not keyed on anything we watch; salvage it only if one of our tokens
      // appears on the maker side, which means the trade is quoted against the
      // complementary outcome.
      const ourLeg = makers.find((m) => this.watched.has(String(m?.tokenId ?? '')));
      if (!ourLeg) return; // genuinely not our market
      ourToken = String(ourLeg.tokenId);
      inverted = true;
    }
    if (!this.watched.has(ourToken)) return;

    // The correction from order.rs:1095: a price quoted against the
    // complementary token is worth (1 - price) from our side.
    const price = inverted ? Number((1 - rawPrice).toFixed(6)) : rawPrice;
    const side = String(p.side ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

    this.seen.add(dedupeKey);
    // Unbounded growth over a long session would leak; a match cannot re-arrive
    // after this many later trades.
    if (this.seen.size > 5_000) {
      this.seen = new Set([...this.seen].slice(-2_500));
    }

    const fill: Fill = {
      tradeId,
      orderId,
      tokenId: ourToken,
      price,
      size,
      side,
      inverted,
      receivedAt: Date.now(),
    };
    this.applyToPosition(fill);
    this.emit('fill', fill);
  }

  private applyToPosition(fill: Fill): void {
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
