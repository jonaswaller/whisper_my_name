/**
 * Standing-order price rules.
 *
 * "Sell at 99.9c" is only legal where the tick is 0.001. Live LoL markets carry
 * both 0.001 and 0.01, and a market's tick can change while it is open — so the
 * price must be derived from the market, never assumed, and clamping must be
 * visible rather than silent.
 */

import {
  clampPrice,
  maxRestingPrice,
  minRestingPrice,
  normalizeOpenOrder,
  listOpenOrders,
  sellableShares,
  isInsufficientBalanceError,
  limitBuyShares,
  placeLimitBuy,
} from '../src/agent/limitOrders.ts';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
  if (!ok) failures += 1;
}

console.log('\nresting price limits:\n');

check('max price on a 0.001 market', maxRestingPrice(0.001), 0.999);
check('max price on a 0.01 market', maxRestingPrice(0.01), 0.99);
check('min price is one tick', minRestingPrice(0.001), 0.001);

// The headline case: his "sell at 99.9c" button.
check('99.9c is placeable at 0.001 tick', clampPrice(0.999, 0.001), { price: 0.999 });
check('99.9c clamps to 0.99 at 0.01 tick, and says so', clampPrice(0.999, 0.01), {
  price: 0.99,
  adjusted: 'capped at 0.99 (tick 0.01)',
});

check('a price above $1 can never rest', clampPrice(1.5, 0.001), {
  price: 0.999,
  adjusted: 'capped at 0.999 (tick 0.001)',
});
check('zero is raised to one tick', clampPrice(0, 0.01), {
  price: 0.01,
  adjusted: 'raised to the 0.01 minimum',
});

// Rounds DOWN: for a sell, rounding up would ask more than he chose and could
// leave the order sitting unfilled above the price he actually wanted.
check('off-tick price rounds down and reports it', clampPrice(0.8567, 0.01), {
  price: 0.85,
  adjusted: 'rounded to the 0.01 tick',
});
check('an on-tick price is left alone', clampPrice(0.85, 0.01), { price: 0.85 });

console.log('\nopen-order normalization:\n');

const parsed = normalizeOpenOrder({
  id: '0xabc',
  asset_id: '123',
  side: 'SELL',
  price: '0.85',
  original_size: '100',
  size_matched: '40',
  created_at: '1785451435',
});
check('remaining = original - matched', parsed.remaining, 60);
check('seconds timestamps become milliseconds', parsed.createdAt, 1785451435000);
check('id/asset aliases resolve', [parsed.orderId, parsed.tokenId], ['0xabc', '123']);

console.log('\nsell-all availability:\n');

const resting = [
  { tokenId: 'mine', side: 'SELL' as const, remaining: 40 },
  { tokenId: 'mine', side: 'BUY' as const, remaining: 99 },
  { tokenId: 'other', side: 'SELL' as const, remaining: 500 },
];
check('resting sells are subtracted from the held position', sellableShares(100, resting, 'mine'), 60);
check('reserved shares can never make availability negative', sellableShares(20, resting, 'mine'), 0);
check('balance rejection is recognized', isInsufficientBalanceError('not enough balance / allowance'), true);
check('an unrelated rejection is not retried', isInsufficientBalanceError('invalid tick size'), false);

console.log('\npaginated listOpenOrders:\n');

// The SDK returns Paginated<OpenOrder[]> — an async iterable of pages, not an
// array. Reading it as an array returned nothing while a real order was resting
// on the book, and said so silently. Verified live; locked down here.
function paginatorClient(pages: unknown[]) {
  return {
    listOpenOrders() {
      return {
        async *[Symbol.asyncIterator]() {
          for (const p of pages) yield p;
        },
        async firstPage() {
          return pages[0];
        },
      };
    },
  } as any;
}

const row = (id: string) => ({
  id,
  asset_id: 'tok',
  side: 'SELL',
  price: '0.99',
  original_size: '10',
  size_matched: '0',
});

check(
  'walks every page of an async paginator',
  (await listOpenOrders(paginatorClient([{ data: [row('a'), row('b')] }, { data: [row('c')] }]))).map(
    (o) => o.orderId,
  ),
  ['a', 'b', 'c'],
);

check(
  'accepts a bare array page',
  (await listOpenOrders(paginatorClient([[row('x')]]))).map((o) => o.orderId),
  ['x'],
);

check('empty paginator yields nothing', await listOpenOrders(paginatorClient([])), []);

check(
  'falls back to a plain array client',
  (await listOpenOrders({ listOpenOrders: () => [row('z')] } as any)).map((o) => o.orderId),
  ['z'],
);

console.log('\nresting buy sizing:\n');

// His example: $200 on a 69c bid. Limit orders are sized in shares, floored to
// the venue's 0.01-share precision so the order never commits more than $200.
check('$200 at 0.69 is 289.85 shares', limitBuyShares(200, 0.69), 289.85);
check('$200 at 0.50 is exactly 400 shares', limitBuyShares(200, 0.5), 400);
check('$3 at 0.07 floors, not rounds', limitBuyShares(3, 0.07), 42.85);
check('float noise does not lose a cent: $1 at 0.1', limitBuyShares(1, 0.1), 10);
check('zero price is zero shares', limitBuyShares(200, 0), 0);
check('zero notional is zero shares', limitBuyShares(0, 0.5), 0);

{
  // A fake client that records what would be signed.
  const reqs: any[] = [];
  const client: any = {
    async createLimitOrder(req: any) { reqs.push(req); return { signed: req }; },
    async postOrder() { return { success: true, orderId: '0xbuy' }; },
    async cancelOrder() {}, async cancelAll() {}, listOpenOrders() { return []; },
  };
  const res = await placeLimitBuy(client, { tokenId: 't', notional: 200, price: 0.69, tickSize: 0.01, minOrderSize: 5 });
  check('limit buy posts BUY side, shares not dollars', { side: reqs[0].side, size: reqs[0].size, price: reqs[0].price }, { side: 'BUY', size: 289.85, price: 0.69 });
  check('limit buy reports the order id', { ok: res.ok, orderId: res.orderId, shares: res.shares }, { ok: true, orderId: '0xbuy', shares: 289.85 });

  const tiny = await placeLimitBuy(client, { tokenId: 't', notional: 2, price: 0.69, tickSize: 0.01, minOrderSize: 5 });
  check('limit buy below venue minimum is refused before signing', { ok: tiny.ok, posts: reqs.length }, { ok: false, posts: 1 });
  check('limit buy min-size refusal says why', /below the venue minimum/.test(tiny.error ?? ''), true);

  // Off-tick bid (e.g. a 0.001 quote on a market we think is 0.01) rounds down and says so.
  const rounded = await placeLimitBuy(client, { tokenId: 't', notional: 200, price: 0.695, tickSize: 0.01, minOrderSize: 5 });
  check('limit buy snaps an off-tick price and reports it', { price: rounded.price, adjusted: rounded.adjusted }, { price: 0.69, adjusted: 'rounded to the 0.01 tick' });
}

console.log(failures ? `\n${failures} FAILURES\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
