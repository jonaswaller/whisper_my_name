/**
 * Find the idle timeout where a pooled connection goes cold.
 *
 * This sets the heartbeat interval. Too slow and the first order of a quiet
 * spell pays a fresh TCP+TLS handshake; too fast and we burn rate limit for
 * nothing. bill_sheng_code hit exactly this — their ingress dropped idle
 * connections in ~2-4.5s and isolated orders paid +145ms (AI_HANDOFF.md:1147).
 *
 *   npx tsx scripts/measure-warmth.ts
 */

import { Agent, setGlobalDispatcher, request } from 'undici';

const URL = 'https://clob.polymarket.com/ok';
/** Idle gaps to probe, in seconds. */
const GAPS = [0, 1, 2, 5, 10, 20, 30, 45, 60, 90];

const agent = new Agent({
  keepAliveTimeout: 120_000,
  keepAliveMaxTimeout: 600_000,
  connections: 4,
  pipelining: 1,
});
setGlobalDispatcher(agent);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function hit(): Promise<number> {
  const t0 = process.hrtime.bigint();
  const res = await request(URL, { method: 'GET' });
  await res.body.text();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

console.log('\nwarming the pool...');
for (let i = 0; i < 5; i++) await hit();

const baseline: number[] = [];
for (let i = 0; i < 8; i++) {
  baseline.push(await hit());
  await sleep(120);
}
baseline.sort((a, b) => a - b);
const warm = baseline[Math.floor(baseline.length / 2)]!;
console.log(`warm baseline (back-to-back): p50 ${warm.toFixed(1)}ms\n`);

console.log('idle gap -> first request latency after that gap:');
const results: { gap: number; ms: number }[] = [];
for (const gap of GAPS) {
  await sleep(gap * 1000);
  const ms = await hit();
  results.push({ gap, ms });
  const delta = ms - warm;
  const flag = delta > warm * 0.6 ? '  <-- COLD (handshake)' : '';
  console.log(`  ${String(gap).padStart(3)}s idle  ->  ${ms.toFixed(1).padStart(7)}ms   (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}ms)${flag}`);
  // Re-warm so each gap is measured from a known-warm pool.
  await hit();
}

const firstCold = results.find((r) => r.ms > warm * 1.6);
console.log(
  firstCold
    ? `\nfirst cold at ${firstCold.gap}s idle -> heartbeat well inside that, e.g. every ${Math.max(2, Math.floor(firstCold.gap / 3))}s`
    : `\nno cold draw up to ${GAPS[GAPS.length - 1]}s — the pool held throughout`,
);
await agent.close();
