/**
 * Presign cache behaviour, especially the staleness rule.
 *
 * The dangerous direction is the ask FALLING: a cap signed at a higher ask is
 * still fillable, so it would fire happily and pay far more slippage than the
 * button advertises. These assert that never happens silently.
 */

import { EventEmitter } from 'node:events';
import { PresignCache, type Tier } from '../src/agent/presign.ts';

const TOKEN = 'tok-A';
const TARGET = { tokenId: TOKEN, tickSize: 0.01, minOrderSize: 5 };
const TIERS: Tier[] = [
  { label: 'small', notional: 50, slippageCents: 3 },
  { label: 'semi-big', notional: 250, slippageCents: 8 },
];

/** Minimal stand-in for BookFeed with a settable ask. */
class FakeBook extends EventEmitter {
  ask = 0.85;
  top(tokenId: string) {
    return tokenId === TOKEN
      ? { bid: this.ask - 0.01, bidSize: 100, ask: this.ask, askSize: 100, ageMs: 0 }
      : null;
  }
  move(ask: number) {
    this.ask = ask;
    this.emit('update', TOKEN);
  }
}

class FakeSigner {
  calls: { maxPrice: number; amount: number }[] = [];
  delayMs = 0;
  async createMarketOrder(req: Record<string, any>) {
    this.calls.push({ maxPrice: req.maxPrice, amount: req.amount });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return { __signedAt: req.maxPrice, makerAmount: String(req.amount) };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures += 1;
  }
}

console.log('\npresign cache:\n');

// --- arm warms every slot up front ------------------------------------------
{
  const book = new FakeBook();
  const signer = new FakeSigner();
  const cache = new PresignCache(signer as any, book as any, { debounceMs: 10 });
  await cache.arm([TARGET], TIERS);

  check('arm() signs every tier immediately', signer.calls.length === 2, `${signer.calls.length} signs`);
  check(
    'caps match ask + slippage',
    signer.calls.some((c) => c.maxPrice === 0.88) && signer.calls.some((c) => c.maxPrice === 0.93),
    JSON.stringify(signer.calls.map((c) => c.maxPrice)),
  );
  check('all slots report ready', cache.status().every((s) => s.ready));
  cache.close();
}

// --- a press with an unchanged book uses the cache ---------------------------
{
  const book = new FakeBook();
  const signer = new FakeSigner();
  const cache = new PresignCache(signer as any, book as any, { debounceMs: 10 });
  await cache.arm([TARGET], TIERS);
  const before = signer.calls.length;

  const taken = await cache.take(TARGET, 0);
  check('press returns a presigned order', taken?.presigned === true);
  check('press costs no signing time', taken?.signMs === 0, `${taken?.signMs}ms`);
  check('cap is the one we armed with', taken?.maxPrice === 0.88, String(taken?.maxPrice));

  await sleep(50);
  check(
    'consuming a slot triggers a refill',
    signer.calls.length === before + 1,
    `${signer.calls.length - before} extra signs`,
  );
  cache.close();
}

// --- the dangerous case: ask falls, cached cap is too generous ---------------
{
  const book = new FakeBook();
  const signer = new FakeSigner();
  const cache = new PresignCache(signer as any, book as any, { debounceMs: 10_000 });
  await cache.arm([TARGET], TIERS);

  // Debounce is long, so the cache cannot silently re-sign behind our back.
  book.ask = 0.70; // would now cap at 0.73, not 0.88 — 15 ticks of drift

  const taken = await cache.take(TARGET, 0);
  check('stale-low cap is REFUSED, signs inline instead', taken?.presigned === false);
  check('inline cap reflects the new ask', taken?.maxPrice === 0.73, String(taken?.maxPrice));
  cache.close();
}

// --- a one-tick wobble should still use the cache ---------------------------
{
  const book = new FakeBook();
  const signer = new FakeSigner();
  const cache = new PresignCache(signer as any, book as any, { debounceMs: 10_000 });
  await cache.arm([TARGET], TIERS);

  book.ask = 0.86; // cap would be 0.89 vs cached 0.88 — one tick

  const taken = await cache.take(TARGET, 0);
  check('one-tick drift still uses the cache', taken?.presigned === true, `presigned=${taken?.presigned}`);
  cache.close();
}

// --- re-arming must invalidate in-flight signatures -------------------------
{
  const book = new FakeBook();
  const signer = new FakeSigner();
  signer.delayMs = 60;
  const cache = new PresignCache(signer as any, book as any, { debounceMs: 10_000 });
  const arming = cache.arm([TARGET], TIERS);
  await sleep(10);
  await cache.arm([TARGET], TIERS); // switch markets mid-flight
  await arming;
  await sleep(150);

  const ready = cache.status().filter((s) => s.ready).length;
  check('re-arm discards stale in-flight signatures', ready === 2, `${ready} ready slots`);
  cache.close();
}

console.log(failures ? `\n${failures} FAILURES\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
