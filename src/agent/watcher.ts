/**
 * Watches another trader's activity and reports their fills.
 *
 * He trades the same LoL markets as this account, so knowing what he just did —
 * side, size, and the price he actually got — is a signal in itself.
 *
 * Polling rather than a socket: the Data API has no public per-user stream, and
 * a 2s poll is well inside "within seconds", which is all that was asked for.
 */

import { EventEmitter } from 'node:events';

const DATA_API = 'https://data-api.polymarket.com';
const POLL_MS = 2_000;
/** Enough to catch a burst between polls without re-reading pages of history. */
const PAGE = 25;

export interface WatchedTrade {
  /** Unique per fill; the same trade re-appears on every poll otherwise. */
  key: string;
  at: number;
  side: 'BUY' | 'SELL';
  /** Shares. */
  size: number;
  /** Dollars. */
  usdc: number;
  price: number;
  /** Team or outcome name, e.g. "Invictus Gaming". */
  outcome: string;
  /** Market question. */
  title: string;
  eventSlug: string;
  tokenId: string;
  /** True when this market is the one currently armed. */
  isArmedMarket?: boolean;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Emits:
 *   'trade' (t: WatchedTrade)  — a fill we have not reported before
 *   'error' (err: Error)
 */
export class ActivityWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private seen = new Set<string>();
  private recent: WatchedTrade[] = [];
  /** First poll only records history; it must not alert on old trades. */
  private primed = false;
  private lastPollAt = 0;
  private lastError: string | null = null;

  constructor(private wallet: string) {
    super();
  }

  getWallet(): string {
    return this.wallet;
  }

  /** Point at a different trader. Clears history so old fills don't re-alert. */
  setWallet(wallet: string): void {
    if (wallet.toLowerCase() === this.wallet.toLowerCase()) return;
    this.wallet = wallet;
    this.seen.clear();
    this.recent = [];
    this.primed = false;
  }

  list(): WatchedTrade[] {
    return this.recent;
  }

  status(): { wallet: string; lastPollAt: number; error: string | null; count: number } {
    return {
      wallet: this.wallet,
      lastPollAt: this.lastPollAt,
      error: this.lastError,
      count: this.recent.length,
    };
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (!this.wallet) return;
    try {
      const res = await fetch(
        `${DATA_API}/activity?user=${encodeURIComponent(this.wallet)}&limit=${PAGE}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as unknown;
      this.lastPollAt = Date.now();
      this.lastError = null;
      if (!Array.isArray(rows)) return;

      const fresh: WatchedTrade[] = [];
      for (const raw of rows as Record<string, any>[]) {
        // The feed also carries MAKER_REBATE / TAKER_REBATE rows, which are fee
        // credits with no side, price or market — not trades.
        if (String(raw.type ?? '').toUpperCase() !== 'TRADE') continue;

        const at = num(raw.timestamp) * 1000;
        // Rebates share a transaction hash with their trade, so the key needs
        // the asset and timestamp too.
        const key = `${raw.transactionHash ?? ''}:${raw.asset ?? ''}:${raw.timestamp ?? ''}`;
        if (this.seen.has(key)) continue;
        this.seen.add(key);

        fresh.push({
          key,
          at,
          side: String(raw.side ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
          size: num(raw.size),
          usdc: num(raw.usdcSize),
          price: num(raw.price),
          outcome: String(raw.outcome ?? ''),
          title: String(raw.title ?? ''),
          eventSlug: String(raw.eventSlug ?? ''),
          tokenId: String(raw.asset ?? ''),
        });
      }

      // Oldest first so the newest ends up at the top of the list.
      fresh.sort((a, b) => a.at - b.at);
      this.recent = [...fresh.reverse(), ...this.recent].slice(0, 100);

      if (this.seen.size > 2_000) {
        this.seen = new Set([...this.seen].slice(-1_000));
      }

      // The first poll is history, not news — alerting on it would fire a dozen
      // stale notifications the moment the app opens.
      if (!this.primed) {
        this.primed = true;
        return;
      }
      for (const t of fresh) this.emit('trade', t);
    } catch (err: any) {
      this.lastError = err?.message ?? String(err);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }
}
