/**
 * Session-level sell safety with a fake client and fake Data API.
 *
 * These exercise the orchestration that pure sizing tests cannot: resting
 * reservations, an insufficient-balance rejection, authoritative recovery,
 * and the one-time retry. No network calls and no orders leave this process.
 */

import { Session } from '../src/agent/session.ts';
import { DEFAULT_CONFIG } from '../src/agent/config.ts';

const TOKEN_A = '101';
const TOKEN_B = '202';
let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`),
  );
  if (!ok) failures += 1;
}

function clientWithResponses(responses: any[]) {
  const marketShares: number[] = [];
  const limitShares: number[] = [];
  let posts = 0;
  const client = {
    marketShares,
    limitShares,
    get posts() { return posts; },
    async createMarketOrder(req: any) {
      marketShares.push(req.shares);
      return { kind: 'market', req };
    },
    async createLimitOrder(req: any) {
      limitShares.push(req.size);
      return { kind: 'limit', req };
    },
    async postOrder() {
      const response = responses[Math.min(posts, responses.length - 1)];
      posts += 1;
      return response;
    },
    listOpenOrders() { return []; },
    async cancelOrder() { return { success: true }; },
    async cancelAll() { return { success: true }; },
    async subscribe() {
      return {
        async *[Symbol.asyncIterator]() { await new Promise(() => {}); },
        close() {},
      };
    },
  };
  return client;
}

function makeSession(client: any, localShares: number, restingShares = 0): Session {
  const config = structuredClone(DEFAULT_CONFIG);
  config.dryRun = false;
  config.watchWallet = '';
  const session = new Session(client, '0x1111111111111111111111111111111111111111', config);
  const raw = session as any;
  raw.market = {
    question: 'test market',
    slug: 'test-market',
    minOrderSize: 5,
    tickSize: 0.01,
    teamA: { tokenId: TOKEN_A, name: 'A' },
    teamB: { tokenId: TOKEN_B, name: 'B' },
  };
  raw.book.top = () => ({ bid: 0.5, ask: 0.51, bidSize: 1_000, askSize: 1_000, ageMs: 0 });
  raw.book.tickSize = () => 0.01;
  raw.fills.watch([TOKEN_A, TOKEN_B]);
  raw.fills.seed(TOKEN_A, localShares, 0.4);
  raw.openOrders = restingShares > 0
    ? [{
        orderId: '0xresting', tokenId: TOKEN_A, side: 'SELL', price: 0.8,
        size: restingShares, filled: 0, remaining: restingShares, createdAt: null,
      }]
    : [];
  return session;
}

const acceptedSell = (shares: number) => ({
  success: true,
  orderId: `0xaccepted-${shares}`,
  status: 'matched',
  makingAmount: String(shares),
  takingAmount: String(shares * 0.5),
});
const balanceRejection = {
  success: false,
  errorMsg: 'not enough balance / allowance',
};

const originalFetch = globalThis.fetch;
let authoritativeShares = 0;
globalThis.fetch = (async () => new Response(JSON.stringify([
  {
    asset: TOKEN_A,
    size: String(authoritativeShares),
    avgPrice: '0.4',
    curPrice: '0.5',
    title: 'test',
    outcome: 'A',
  },
]), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

console.log('\nsession sell safety:\n');

// A SELL ALL NOW must not collide with shares already committed to a resting
// sell. It sends the unreserved remainder and leaves the existing order alone.
{
  const client = clientWithResponses([acceptedSell(60)]);
  const session = makeSession(client, 100, 40);
  await session.fire({ kind: 'sell', side: 'A' });
  check('market sell subtracts 40 resting shares', client.marketShares, [60]);
  check('reserved-share sell posts once', client.posts, 1);
  session.close();
}

// The production incident: local ledger says 1782, account really owns 647.
// The first exact sell is rejected; recovery must retry once at 647, never 1782
// again and never a guessed amount.
{
  authoritativeShares = 647;
  const client = clientWithResponses([balanceRejection, acceptedSell(647)]);
  const session = makeSession(client, 1_782);
  const result = await session.fire({ kind: 'sell', side: 'A' });
  check('market sell retries at authoritative maximum', client.marketShares, [1_782, 647]);
  check('market sell retry succeeds', result?.verdict, 'filled');
  session.close();
}

// ASK, typed-price and 99.9c sells share placeStandingSell(), so one test covers
// the common recovery path used by all three.
{
  authoritativeShares = 647;
  const client = clientWithResponses([balanceRejection, { success: true, orderId: '0xlimit' }]);
  const session = makeSession(client, 1_782);
  await session.sellLimitAt('A', 0.8);
  check('standing sell retries at authoritative maximum', client.limitShares, [1_782, 647]);
  check('standing sell retry posts exactly twice', client.posts, 2);
  session.close();
}

globalThis.fetch = originalFetch;
console.log(failures ? `\n${failures} FAILURES\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
