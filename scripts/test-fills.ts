/**
 * Replay the real user-channel events captured during the live $3 round trip.
 *
 * The venue sends MATCHED, then MINED, then CONFIRMED for the SAME trade id.
 * Counting all three would triple every position, so this asserts exactly one
 * fill survives. Uses the captured payload verbatim — no invented fixtures.
 */

import { FillFeed, type Fill } from '../src/agent/fills.ts';

const TEAM_B = '8842039361063407895665178447251374140449970581227373457579811821425592009042';
const TEAM_A = '40472665679887425908378900626110398741048094992392767676262326176479189032482';

/** Captured verbatim from scripts/debug-user-ws.ts during the live sell. */
const captured = (status: string) => ({
  topic: 'user',
  type: 'trade',
  payload: {
    id: '98d5b5c1-4134-43a4-b83c-6e2b8705de7f',
    market: '0x3d4683e6be5d9523eb45f50f27dd1dff77e6932ff3fa9c3a8716fffd06012267',
    side: 'SELL',
    size: '18',
    price: '0.15',
    status,
    outcome: 'EDward Gaming',
    takerOrderId: '0x27ee4245afd42750c6dfd6f217bbf7dbd5089adca01c30a17206d334611a7cd4',
    tokenId: TEAM_B,
    feeRateBps: '0',
    // Redacted: the live capture carried a real wallet address, and nothing
    // here asserts on it.
    makerAddress: '0x1111111111111111111111111111111111111111',
    makerOrders: [
      {
        owner: 'df8daf2d-ecdf-ba1c-1c96-bf1315e6c734',
        price: '0.15',
        outcome: 'EDward Gaming',
        side: 'BUY',
        orderId: '0x23956c38b8edab2ae6337fbf999f2cc9b9ce13e69b7f1c016371c406de8aefe8',
        tokenId: TEAM_B,
        matchedAmount: '18',
      },
    ],
  },
});

/** A merge match: the event is keyed on Team A, but our leg is Team B. */
const mergeMatch = {
  topic: 'user',
  type: 'trade',
  payload: {
    id: 'merge-test-0001',
    side: 'BUY',
    size: '10',
    price: '0.85',
    status: 'TRADE_STATUS_MATCHED',
    takerOrderId: '0xmerge',
    tokenId: TEAM_A,
    makerOrders: [{ orderId: '0xm1', price: '0.85', side: 'BUY', tokenId: TEAM_B, matchedAmount: '10' }],
  },
};

function fakeClient(events: unknown[]) {
  return {
    async subscribe() {
      return {
        async *[Symbol.asyncIterator]() {
          for (const e of events) yield e;
          // Hold open so the reconnect loop doesn't spin during the test.
          await new Promise(() => {});
        },
        close() {},
      };
    },
  };
}

async function run(
  name: string,
  events: unknown[],
  check: (fills: Fill[], feed: FillFeed) => void,
  ourOrders: [string, string][] = [],
) {
  const feed = new FillFeed(fakeClient(events) as any);
  feed.watch([TEAM_A, TEAM_B]);
  for (const [orderId, tokenId] of ourOrders) feed.expectOrder(orderId, tokenId);
  const fills: Fill[] = [];
  feed.on('fill', (f) => fills.push(f));
  await feed.start();
  await new Promise((r) => setTimeout(r, 120));
  try {
    check(fills, feed);
    console.log(`  PASS  ${name}`);
  } catch (err: any) {
    console.log(`  FAIL  ${name} — ${err.message}`);
    process.exitCode = 1;
  }
  feed.close();
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

console.log('\nreplaying captured live events:\n');

await run(
  'MATCHED/MINED/CONFIRMED for one trade -> exactly one fill',
  [captured('TRADE_STATUS_MATCHED'), captured('TRADE_STATUS_MINED'), captured('TRADE_STATUS_CONFIRMED')],
  (fills) => {
    assert(fills.length === 1, `expected 1 fill, got ${fills.length}`);
    const f = fills[0]!;
    assert(f.side === 'SELL', `side ${f.side}`);
    assert(f.size === 18, `size ${f.size}`);
    assert(f.price === 0.15, `price ${f.price}`);
    assert(!f.inverted, 'same-token match must not invert');
  },
);

await run('sell moves the seeded position to flat', [captured('TRADE_STATUS_MATCHED')], (_f, feed) => {
  const p = feed.position(TEAM_B);
  assert(p.shares === -18, `expected -18 from flat, got ${p.shares}`);
});

// We ordered TEAM_B but the venue keyed the trade on TEAM_A: our true price is
// 1 - 0.85 = 0.15. Without the order->token record this is undetectable.
await run(
  'merge match inverts the price (0.85 -> 0.15)',
  [mergeMatch],
  (fills) => {
    assert(fills.length === 1, `expected 1 fill, got ${fills.length}`);
    const f = fills[0]!;
    assert(f.inverted, 'merge match should be flagged inverted');
    assert(f.tokenId === TEAM_B, `should attribute to our leg, got ${f.tokenId.slice(0, 8)}`);
    assert(f.price === 0.15, `expected 1-0.85=0.15, got ${f.price}`);
  },
  [['0xmerge', TEAM_B]],
);

// The same event WITHOUT the order record: no basis to invert, so take it at
// face value rather than guessing. Documents the limit of what is knowable.
await run('unknown order on a watched token is taken at face value', [mergeMatch], (fills) => {
  assert(fills.length === 1, `expected 1 fill, got ${fills.length}`);
  assert(!fills[0]!.inverted, 'should not invert without an order record');
});

await run('unrelated market is ignored', [
  { topic: 'user', type: 'trade', payload: { ...captured('TRADE_STATUS_MATCHED').payload, tokenId: '999', makerOrders: [] } },
], (fills) => {
  assert(fills.length === 0, `expected 0 fills, got ${fills.length}`);
});

console.log(process.exitCode ? '\nFAILURES\n' : '\nall passed\n');
process.exit(process.exitCode ?? 0);
