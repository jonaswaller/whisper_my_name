/**
 * Live top-of-book cache.
 *
 * The whole point of this module is that `top()` is a synchronous map lookup.
 * A REST /book call costs ~126ms measured; the hotkey path cannot afford one,
 * so the book is streamed in continuously and read from memory at press time.
 *
 * Wire contract verified live against the LPL event:
 *   wss://ws-subscriptions-clob.polymarket.com/ws/market
 *   subscribe -> {assets_ids: [...], type: "market"}
 *   "book"         full snapshot per asset; BEST IS THE LAST ELEMENT of each
 *                  side (bids ascending, asks descending)
 *   "price_change" level replacements; side "BUY" is the bid side, size "0"
 *                  removes the level
 */

import WebSocket from 'ws';
import { EventEmitter } from 'node:events';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/** Polymarket drops idle sockets; keep it hot well inside that window. */
const PING_INTERVAL_MS = 5_000;
/** No traffic at all for this long means the socket is dead even if TCP hasn't noticed. */
const STALL_TIMEOUT_MS = 20_000;
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 5_000;

export interface TopOfBook {
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  /** Milliseconds since this token last received an update. */
  ageMs: number;
}

interface Level {
  price: number;
  size: number;
}

interface BookState {
  bids: Map<number, number>;
  asks: Map<number, number>;
  bestBid: Level | null;
  bestAsk: Level | null;
  updatedAt: number;
  /**
   * Live tick size for this token.
   *
   * Not a constant: the venue changes it as a market matures, and the same LPL
   * market read 0.01 one week and 0.001 the next. An order priced off a stale
   * tick is off-tick and rejected, so this tracks the stream rather than the
   * value Gamma reported when the market was armed.
   */
  tickSize: number | null;
}

function parseLevels(raw: unknown): Map<number, number> {
  const out = new Map<number, number>();
  if (!Array.isArray(raw)) return out;
  for (const lvl of raw) {
    const price = Number(lvl?.price);
    const size = Number(lvl?.size);
    if (Number.isFinite(price) && Number.isFinite(size) && size > 0) out.set(price, size);
  }
  return out;
}

/** Best bid is the highest price; best ask the lowest. */
function recomputeBest(state: BookState): void {
  let bestBid: Level | null = null;
  for (const [price, size] of state.bids) {
    if (bestBid === null || price > bestBid.price) bestBid = { price, size };
  }
  let bestAsk: Level | null = null;
  for (const [price, size] of state.asks) {
    if (bestAsk === null || price < bestAsk.price) bestAsk = { price, size };
  }
  state.bestBid = bestBid;
  state.bestAsk = bestAsk;
}

export type FeedStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

/**
 * Emits:
 *   'status' (status: FeedStatus)  — drives the HUD connection light
 *   'update' (tokenId: string)     — top of book may have moved
 *   'error'  (err: Error)
 */
export class BookFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private books = new Map<string, BookState>();
  private tokenIds: string[] = [];
  private pingTimer: NodeJS.Timeout | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private status: FeedStatus = 'closed';

  /**
   * Point the feed at a new set of tokens. Called on arm, and again whenever he
   * switches markets mid-BO3.
   */
  subscribe(tokenIds: string[]): void {
    this.tokenIds = [...tokenIds];
    this.books.clear();
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.reopen();
  }

  /**
   * Synchronous top-of-book read — this is the hot path. Returns null until the
   * first snapshot lands, so callers must treat null as "do not trade".
   */
  top(tokenId: string): TopOfBook | null {
    const state = this.books.get(tokenId);
    if (!state || !state.bestBid || !state.bestAsk) return null;
    return {
      bid: state.bestBid.price,
      bidSize: state.bestBid.size,
      ask: state.bestAsk.price,
      askSize: state.bestAsk.size,
      ageMs: Date.now() - state.updatedAt,
    };
  }

  /**
   * Live tick size from the stream, or null before the first snapshot. Callers
   * should fall back to the market's arm-time value when this is null.
   */
  tickSize(tokenId: string): number | null {
    return this.books.get(tokenId)?.tickSize ?? null;
  }

  getStatus(): FeedStatus {
    return this.status;
  }

  close(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    this.setStatus('closed');
  }

  private setStatus(next: FeedStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.emit('status', next);
  }

  private clearTimers(): void {
    for (const t of [this.pingTimer, this.stallTimer, this.reconnectTimer]) {
      if (t) clearTimeout(t);
    }
    this.pingTimer = this.stallTimer = this.reconnectTimer = null;
  }

  private reopen(): void {
    if (this.stopped || this.tokenIds.length === 0) return;
    this.clearTimers();
    this.ws?.removeAllListeners();
    this.ws?.close();

    this.setStatus(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({ assets_ids: this.tokenIds, type: 'market' }));
      this.reconnectAttempt = 0;
      this.armStallTimer();
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('PING');
      }, PING_INTERVAL_MS);
    });

    ws.on('message', (raw) => this.onMessage(raw.toString()));
    ws.on('error', (err) => this.emit('error', err));
    ws.on('close', () => this.scheduleReconnect());
  }

  /** Any inbound traffic proves the socket is alive; restart the deadline. */
  private armStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      this.emit('error', new Error('book feed stalled — no traffic, reconnecting'));
      this.ws?.close();
    }, STALL_TIMEOUT_MS);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearTimers();
    this.setStatus('reconnecting');
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.reopen(), delay);
  }

  private onMessage(text: string): void {
    this.armStallTimer();
    if (text === 'PONG') return;

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }

    const messages = Array.isArray(payload) ? payload : [payload];
    for (const msg of messages) {
      const m = msg as Record<string, any>;
      switch (m.event_type) {
        case 'book':
          this.applySnapshot(m);
          break;
        case 'price_change':
          this.applyPriceChange(m);
          break;
        case 'tick_size_change':
          this.applyTickChange(m);
          break;
        // last_trade_price carries nothing the hot path needs.
      }
    }
  }

  private applySnapshot(m: Record<string, any>): void {
    const tokenId = String(m.asset_id ?? '');
    if (!tokenId) return;
    const tick = Number(m.tick_size);
    const state: BookState = {
      bids: parseLevels(m.bids),
      asks: parseLevels(m.asks),
      bestBid: null,
      bestAsk: null,
      updatedAt: Date.now(),
      // Carry the previous tick forward if a snapshot omits it.
      tickSize: Number.isFinite(tick) && tick > 0
        ? tick
        : (this.books.get(tokenId)?.tickSize ?? null),
    };
    recomputeBest(state);
    this.books.set(tokenId, state);
    this.setStatus('live');
    this.emit('update', tokenId);
  }

  /**
   * The venue changed this market's price increment. Everything priced off the
   * old tick — presigned caps, the "sell at max" price — is now wrong, so this
   * is announced rather than absorbed silently.
   */
  private applyTickChange(m: Record<string, any>): void {
    const tokenId = String(m.asset_id ?? '');
    const next = Number(m.new_tick_size ?? m.tick_size);
    const state = this.books.get(tokenId);
    if (!state || !Number.isFinite(next) || next <= 0) return;
    if (state.tickSize === next) return;

    state.tickSize = next;
    this.emit('tick-change', tokenId, next);
    this.emit('update', tokenId);
  }

  private applyPriceChange(m: Record<string, any>): void {
    const changes = Array.isArray(m.price_changes) ? m.price_changes : [];
    const touched = new Set<string>();

    for (const change of changes) {
      const tokenId = String(change?.asset_id ?? '');
      const state = this.books.get(tokenId);
      // Ignore deltas for a token whose snapshot hasn't arrived — applying them
      // to an empty book would invent a one-sided top of book.
      if (!state) continue;

      const price = Number(change?.price);
      const size = Number(change?.size);
      if (!Number.isFinite(price) || !Number.isFinite(size)) continue;

      const side = String(change?.side).toUpperCase() === 'BUY' ? state.bids : state.asks;
      if (size > 0) side.set(price, size);
      else side.delete(price);
      touched.add(tokenId);
    }

    const now = Date.now();
    for (const tokenId of touched) {
      const state = this.books.get(tokenId)!;
      recomputeBest(state);
      state.updatedAt = now;
      this.emit('update', tokenId);
    }
  }
}
