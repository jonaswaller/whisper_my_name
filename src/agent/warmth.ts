/**
 * Keeps the connection to the CLOB hot.
 *
 * Presigning already removes signing from the hot path, so the only network
 * call left on a keypress is the POST itself. A cold POST pays a fresh TCP+TLS
 * handshake — measured at +180-210ms against a ~164ms warm baseline, which is
 * most of the venue's own 250ms hold wasted on setup.
 *
 * WHY A HEARTBEAT AND NOT JUST keepAlive: an idle pooled socket still gets
 * reaped, by the origin, by Cloudflare, or by a NAT table on a home router.
 * bill_sheng_code chased this for a full day and landed on the same answer —
 * a HELD, actively-used connection never draws cold, while fresh ones draw from
 * a "warm-cache lottery" (AI_HANDOFF.md:1181).
 *
 * THE TRAP THEY HIT: on HTTP/1 an order can serialise BEHIND an in-flight
 * heartbeat on the same socket — one measured 210ms stall, ~7% duty-cycle risk
 * (AI_HANDOFF.md:1191). So the pool is sized above one connection, leaving a
 * free socket for the order while a heartbeat is in flight.
 */

import { Agent, setGlobalDispatcher, request } from 'undici';
import { EventEmitter } from 'node:events';

const HEALTH_URL = 'https://clob.polymarket.com/ok';

/**
 * Well inside any plausible idle timeout. The measured latency curve was too
 * noisy to locate a real cliff, and at 6 requests/minute the cost of simply
 * being generous is nil.
 */
const HEARTBEAT_MS = 10_000;

/** A request this much slower than the warm median is treated as a cold draw. */
const COLD_MULTIPLIER = 1.6;

export interface WarmthStatus {
  /** A recent heartbeat succeeded. */
  warm: boolean;
  /** Median heartbeat latency over the recent window. */
  medianMs: number;
  lastMs: number;
  /** Cold draws seen this session — expected to be non-zero, it's a lottery. */
  coldDraws: number;
  lastBeatAt: number;
}

/**
 * Emits:
 *   'cold'  (ms: number)  — a heartbeat came back handshake-slow
 *   'error' (err: Error)
 */
export class ConnectionWarmer extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private samples: number[] = [];
  private lastMs = 0;
  private lastBeatAt = 0;
  private coldDraws = 0;
  private warm = false;
  private readonly agent: Agent;

  constructor(private readonly intervalMs = HEARTBEAT_MS) {
    super();
    this.agent = new Agent({
      keepAliveTimeout: 120_000,
      keepAliveMaxTimeout: 600_000,
      // More than one so an order never queues behind an in-flight heartbeat.
      connections: 4,
      pipelining: 1,
    });
    // The SDK posts through global fetch, so installing this dispatcher is what
    // makes orders ride the warmed pool rather than opening their own sockets.
    setGlobalDispatcher(this.agent);
  }

  async start(): Promise<void> {
    await this.beat(); // warm before the first keypress can happen
    this.timer = setInterval(() => void this.beat(), this.intervalMs);
    // Don't hold the process open on this alone.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.agent.close().catch(() => {});
  }

  status(): WarmthStatus {
    return {
      warm: this.warm,
      medianMs: this.median(),
      lastMs: this.lastMs,
      coldDraws: this.coldDraws,
      lastBeatAt: this.lastBeatAt,
    };
  }

  private median(): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }

  private async beat(): Promise<void> {
    const t0 = process.hrtime.bigint();
    try {
      const res = await request(HEALTH_URL, { method: 'GET' });
      await res.body.text(); // drain, else the socket cannot be reused
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;

      this.lastMs = ms;
      this.lastBeatAt = Date.now();
      this.warm = true;

      // Compare against the established median BEFORE folding this sample in,
      // so a run of cold draws can't quietly raise the bar for "cold".
      const baseline = this.median();
      if (baseline > 0 && ms > baseline * COLD_MULTIPLIER) {
        this.coldDraws += 1;
        this.emit('cold', ms);
      }

      this.samples.push(ms);
      if (this.samples.length > 30) this.samples.shift();
    } catch (err) {
      this.warm = false;
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }
}
