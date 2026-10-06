/**
 * Near-free buy: cents cap -> legal price, and the presigned-order cache.
 * No network; the signer is a fake that records what it was asked to sign.
 */

import { floorCap, FloorOrderCache, type FloorTarget } from '../src/agent/floorBuy.ts';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
  if (!ok) failures += 1;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

console.log('\nnear-free cap:\n');

check('0.1c on a 0.001 market is 0.001', floorCap(0.1, 0.001).maxPrice, 0.001);
check('1c on a 0.01 market is 0.01', floorCap(1, 0.01).maxPrice, 0.01);
check('1c on a 0.001 market is 0.01', floorCap(1, 0.001).maxPrice, 0.01);
check('0.3c survives float division', floorCap(0.3, 0.001).maxPrice, 0.003);
check('0.15c rounds DOWN, never pays more than typed', floorCap(0.15, 0.001).maxPrice, 0.001);
// He typed 0.1c; the market's lowest price is 1c. Rounding up would be ten
// times his price, so it declines and says why — same rule as "99.9c".
{
  const coarse = floorCap(0.1, 0.01);
  check('0.1c on a 0.01 market declines', coarse.maxPrice, null);
  check('and the reason names the 1c floor', /lowest price is 1c/.test(coarse.declined ?? ''), true);
}

console.log('\nnear-free presign cache:\n');

function fakeSigner(opts: { fail?: boolean } = {}) {
  const calls: any[] = [];
  return {
    calls,
    fail: opts.fail ?? false,
    async createMarketOrder(req: any) {
      calls.push(req);
      await tick();
      if (this.fail) throw new Error('sign failed');
      return { signed: calls.length, req };
    },
  };
}

const target = (over: Partial<FloorTarget> = {}): FloorTarget => ({
  tokenId: 'loser',
  tickSize: 0.001,
  notional: 20,
  capCents: 0.1,
  ...over,
});

// Loads without any book at all — the whole point.
{
  const signer = fakeSigner();
  const cache = new FloorOrderCache(signer);
  cache.sync([target(), target({ tokenId: 'winner' })]);
  await tick(); await tick();
  check('sync signs both sides with no book', signer.calls.length, 2);
  check(
    'it is a FAK BUY of the dollar amount, capped at the floor',
    { side: String(signer.calls[0].side), type: String(signer.calls[0].orderType), amount: signer.calls[0].amount, maxSpend: signer.calls[0].maxSpend, maxPrice: signer.calls[0].maxPrice },
    { side: 'BUY', type: 'FAK', amount: 20, maxSpend: 20, maxPrice: 0.001 },
  );
  check('ready once signed', cache.isReady(target()), true);

  cache.sync([target(), target({ tokenId: 'winner' })]);
  await tick();
  check('a repeat sync with nothing changed signs nothing', signer.calls.length, 2);

  const taken = await cache.take(target());
  check('a press uses the loaded order', [taken?.presigned, taken?.signMs], [true, 0]);
  await tick(); await tick();
  check('and loads the next one behind it', [signer.calls.length, cache.isReady(target())], [3, true]);
}

// He edits the amount or the cents: the loaded order no longer matches.
{
  const signer = fakeSigner();
  const cache = new FloorOrderCache(signer);
  cache.sync([target()]);
  await tick(); await tick();
  check('an amount edit makes the old order unusable', cache.isReady(target({ notional: 50 })), false);
  const inline = await cache.take(target({ notional: 50 }));
  check('a press after an edit signs inline at the new amount', [inline?.presigned, inline?.order.req.amount], [false, 50]);

  cache.sync([target({ capCents: 1 })]);
  await tick(); await tick();
  check('a cents edit re-signs at the new cap', [cache.isReady(target({ capCents: 1 })), signer.calls.at(-1)?.maxPrice], [true, 0.01]);
}

// The tick goes from 0.01 to 0.001 as the price runs to the extreme: a cap
// that declined becomes priceable and must load without a restart.
{
  const signer = fakeSigner();
  const cache = new FloorOrderCache(signer);
  cache.sync([target({ tickSize: 0.01 })]);
  await tick();
  check('a cap the tick cannot price is not signed', signer.calls.length, 0);
  check('and a press on it returns nothing', await cache.take(target({ tickSize: 0.01 })), null);
  cache.sync([target({ tickSize: 0.001 })]);
  await tick(); await tick();
  check('once the tick allows it, it loads', cache.isReady(target()), true);
}

// A market switch must not let a signature for the old token land late.
{
  const signer = fakeSigner();
  const cache = new FloorOrderCache(signer);
  cache.sync([target()]);
  cache.reset();
  await tick(); await tick();
  check('reset discards a signature still in flight', cache.isReady(target()), false);
}

// A failing signer must not be hammered on every book tick.
{
  const signer = fakeSigner({ fail: true });
  const cache = new FloorOrderCache(signer);
  const errors: string[] = [];
  cache.on('error', (e) => errors.push(e.message));
  cache.sync([target()]);
  await tick(); await tick();
  for (let i = 0; i < 20; i++) cache.sync([target()]);
  await tick(); await tick();
  check('after a failure, rapid syncs back off instead of re-signing', [signer.calls.length, errors.length], [1, 1]);
}

console.log(failures ? `\n${failures} FAILURES\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
