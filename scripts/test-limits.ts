/**
 * Standing-order price rules.
 *
 * "Sell at 99.9c" is only legal where the tick is 0.001. Live LoL markets carry
 * both 0.001 and 0.01, and a market's tick can change while it is open — so the
 * price must be derived from the market, never assumed, and clamping must be
 * visible rather than silent.
 */

import { clampPrice, maxRestingPrice, minRestingPrice, normalizeOpenOrder, listOpenOrders } from '../src/agent/limitOrders.ts';

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

console.log(failures ? `\n${failures} FAILURES\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
