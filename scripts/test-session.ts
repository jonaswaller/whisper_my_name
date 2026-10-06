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
  const marketReqs: any[] = [];
  const limitShares: number[] = [];
  const limitReqs: any[] = [];
  let posts = 0;
  const client = {
    marketShares,
    marketReqs,
    limitShares,
    limitReqs,
    get posts() { return posts; },
    async createMarketOrder(req: any) {
      marketShares.push(req.shares);
      marketReqs.push(req);
      return { kind: 'market', req };
    },
    async createLimitOrder(req: any) {
      limitShares.push(req.size);
      limitReqs.push(req);
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

// --- the two resting hotkeys ------------------------------------------------

console.log('\nstanding sell under the bid / standing buy at the bid:\n');

// "69 bid / 70 ask -> sell everything at 68": bid here is 0.50, so 0.49, and it
// goes through the same reservation-aware path as the other standing sells.
{
  const client = clientWithResponses([{ success: true, orderId: '0xbelow' }]);
  const session = makeSession(client, 100, 40);
  await session.sellBelowBid('A');
  const req = client.limitReqs[0];
  check('sell under bid prices 1c below the bid', req?.price, 0.49);
  check('sell under bid is a SELL of the unreserved shares', { side: String(req?.side), size: req?.size }, { side: 'SELL', size: 60 });
  check('sell under bid posts once', client.posts, 1);
  session.close();
}

// The offset is his to edit; 3c under a 0.50 bid is 0.47.
{
  const client = clientWithResponses([{ success: true, orderId: '0xbelow3' }]);
  const session = makeSession(client, 100);
  (session as any).config.sellBelowBidCents = 3;
  await session.sellBelowBid('A');
  check('sell under bid honours the configured offset', client.limitReqs[0]?.price, 0.47);
  session.close();
}

// A second press while the first is still in flight must not offer the shares twice.
{
  const client = clientWithResponses([{ success: true, orderId: '0xbelow' }]);
  const session = makeSession(client, 100);
  await Promise.all([session.sellBelowBid('A'), session.sellBelowBid('A')]);
  check('sell under bid is double-press guarded', client.posts, 1);
  session.close();
}

// Flat: nothing to sell, nothing sent, but the press is still stamped.
{
  const client = clientWithResponses([{ success: true }]);
  const session = makeSession(client, 0);
  await session.sellBelowBid('A');
  check('sell under bid with no position sends nothing', client.posts, 0);
  check('sell under bid with no position stamps why', session.snapshot().lastAction?.detail, 'no position');
  session.close();
}

// "$200 on the 69c bid": here bid 0.50 -> 400 shares, BUY side, resting.
{
  const client = clientWithResponses([{ success: true, orderId: '0xbidbuy' }]);
  const session = makeSession(client, 0);
  await session.buyAtBid('A');
  const req = client.limitReqs[0];
  check('buy at bid is a BUY at the bid price', { side: String(req?.side), price: req?.price }, { side: 'BUY', price: 0.5 });
  check('buy at bid converts $200 into shares at the bid', req?.size, 400);
  check('buy at bid stamps as sent', session.snapshot().lastAction?.outcome, 'sent');
  session.close();
}

// Size is config, subject to the same hard cap as every other buy.
{
  const client = clientWithResponses([{ success: true, orderId: '0xbidbuy' }]);
  const session = makeSession(client, 0);
  (session as any).config.limitBuyNotional = 50;
  await session.buyAtBid('B');
  check('buy at bid uses the configured dollar size', client.limitReqs[0]?.size, 100);
  check('buy at bid targets the side pressed', client.limitReqs[0]?.tokenId, TOKEN_B);
  session.close();
}
{
  const client = clientWithResponses([{ success: true, orderId: '0xbidbuy' }]);
  const session = makeSession(client, 0);
  (session as any).config.limitBuyNotional = 9_999;
  await session.buyAtBid('A');
  check('buy at bid above maxNotionalPerOrder sends nothing', client.posts, 0);
  check('buy at bid above cap stamps blocked', session.snapshot().lastAction?.outcome, 'blocked');
  session.close();
}

// Dry run: lights up, sends nothing.
{
  const client = clientWithResponses([{ success: true, orderId: '0xbidbuy' }]);
  const session = makeSession(client, 100);
  (session as any).config.dryRun = true;
  await session.buyAtBid('A');
  await session.sellBelowBid('A');
  check('dry run sends neither resting order', client.posts, 0);
  check('dry run still stamps', session.snapshot().lastAction?.outcome, 'dry');
  session.close();
}

// No book: refuse to trade blind, same as the FAK keys.
{
  const client = clientWithResponses([{ success: true }]);
  const session = makeSession(client, 100);
  (session as any).book.top = () => null;
  await session.buyAtBid('A');
  check('buy at bid with no book sends nothing', client.posts, 0);
  await session.sellBelowBid('A');
  check('sell under bid with no book sends nothing', client.posts, 0);
  check('no-book refusal is stamped', session.snapshot().lastAction?.detail, 'no book');
  session.close();
}

// --- press-to-fill wiring -----------------------------------------------------
// Every order path must record WHEN the key was pressed alongside its order id,
// or the fill event cannot report signal-to-fill.

console.log('\npress time recorded with every order:\n');

{
  const t0 = Date.now();
  // Distinct order ids per response, and the standing sell goes on B — the
  // market sell arms A's 2s double-press guard, which would block it on A.
  const client = clientWithResponses([
    acceptedSell(100),
    { success: true, orderId: '0xlimB' },
    { success: true, orderId: '0xbuyB' },
    { success: true, orderId: '0xfakA', status: 'matched', makingAmount: '4', takingAmount: '8' },
  ]);
  const session = makeSession(client, 100);
  (session as any).fills.seed(TOKEN_B, 50, 0.4);
  const recorded: Record<string, number | undefined> = {};
  const fills = (session as any).fills;
  const original = fills.expectOrder.bind(fills);
  fills.expectOrder = (orderId: string, tokenId: string, side: string, pressedAt?: number) => {
    recorded[orderId] = pressedAt;
    return original(orderId, tokenId, side, pressedAt);
  };

  await session.fire({ kind: 'sell', side: 'A' });
  await session.sellLimitAt('B', 0.8);
  await session.buyAtBid('B');
  await session.fire({ kind: 'buy', side: 'A', tier: 0 });

  const ids = Object.keys(recorded);
  check('all four order kinds registered an order id', ids.length, 4);
  check(
    'each carried a plausible press timestamp',
    ids.every((id) => typeof recorded[id] === 'number' && recorded[id]! >= t0 && recorded[id]! <= Date.now()),
    true,
  );
  session.close();
}

// --- position is live the moment the POST confirms ---------------------------
// "once i buy, it takes ~2 seconds to show my shares which means i have 2
// seconds being unable to sell": the sell keys read the local ledger, which
// only moved on the websocket confirmation. The POST response must move it.

console.log('\nposition updated from the POST response:\n');

{
  const client = clientWithResponses([
    { success: true, orderId: '0xfakA', status: 'matched', makingAmount: '4', takingAmount: '8' },
  ]);
  const session = makeSession(client, 100);
  await session.fire({ kind: 'buy', side: 'A', tier: 0 });
  check('shares are on the position right after the POST, before any websocket event', session.snapshot().A.shares, 108);

  // The confirmation arrives ~0.65s later. Same order id, same 8 shares.
  (session as any).fills.onEvent({ topic: 'user', type: 'trade', payload: {
    id: 'confirm-1', side: 'BUY', size: '8', price: '0.5', status: 'TRADE_STATUS_MATCHED',
    takerOrderId: '0xfakA', tokenId: TOKEN_A, traderSide: 'TAKER', makerOrders: [],
  } });
  check('the websocket confirmation does not add them again', session.snapshot().A.shares, 108);
  check('the confirmation is still logged with press->fill', /press→fill/.test(session.snapshot().recent.at(-1)?.text ?? ''), true);

  // And the shares are sellable immediately: a market sell sizes off the ledger.
  session.close();
}

{
  // A killed FAK (no shares) must leave the position alone.
  const client = clientWithResponses([{ success: true, orderId: '0xkilled', status: 'live', makingAmount: '0', takingAmount: '0' }]);
  const session = makeSession(client, 100);
  await session.fire({ kind: 'buy', side: 'A', tier: 0 });
  check('a killed order adds nothing to the position', session.snapshot().A.shares, 100);
  session.close();
}

{
  // Selling what was just bought, inside the websocket lag window.
  const client = clientWithResponses([
    { success: true, orderId: '0xfakA', status: 'matched', makingAmount: '4', takingAmount: '8' },
    acceptedSell(8),
  ]);
  const session = makeSession(client, 0);
  await session.fire({ kind: 'buy', side: 'A', tier: 0 });
  const result = await session.fire({ kind: 'sell', side: 'A' });
  // (buys also go through createMarketOrder, in dollars, so filter to the sell's share count)
  check('a sell right after the buy sends the just-bought shares', client.marketShares.filter((n) => n != null), [8]);
  check('and it goes through', result?.verdict, 'filled');
  session.close();
}

// --- near-free buy (keys 2 / 5) -----------------------------------------------
// His screenshot: winner bid 99.9c, "No asks". The loser's book is the mirror
// — offers at 0.1c and no bids — and top() reads a one-sided book as no book,
// so every buy key refused. The near-free key must go through regardless.

console.log('\nnear-free buy on a book the bots think is over:\n');

/** The loser's side of his screenshot: one-sided, tick 0.001. */
function gameLooksOver(session: Session): void {
  const raw = session as any;
  raw.book.top = () => null;
  raw.book.tickSize = () => 0.001;
}
const floorFill = { success: true, orderId: '0xfloor', status: 'matched', makingAmount: '15.77', takingAmount: '15770' };

{
  const client = clientWithResponses([floorFill]);
  const session = makeSession(client, 0);
  gameLooksOver(session);

  await session.fire({ kind: 'buy', side: 'B', tier: 0 });
  check('the normal buy key still refuses this book (unchanged)', [client.posts, session.snapshot().lastAction?.detail], [0, 'no book']);

  const result = await session.buyAtFloor('B');
  const req = client.marketReqs[0];
  check('the near-free key sends on it', client.posts, 1);
  check(
    'a FAK BUY of B for $20, capped at 0.1c',
    { token: req?.tokenId, side: String(req?.side), type: String(req?.orderType), amount: req?.amount, maxPrice: req?.maxPrice },
    { token: TOKEN_B, side: 'BUY', type: 'FAK', amount: 20, maxPrice: 0.001 },
  );
  check('the fill is reported', result?.verdict, 'filled');
  check('the shares are on B at once, at 0.001', [session.snapshot().B.shares, session.snapshot().B.avgPrice], [15_770, 0.001]);
  session.close();
}

{
  // Presigned at arm, so the press is a POST only.
  const client = clientWithResponses([floorFill]);
  const session = makeSession(client, 0);
  gameLooksOver(session);
  (session as any).syncFloor();
  await new Promise((r) => setTimeout(r, 0));
  check('both sides load with no book', [session.snapshot().A.floor.ready, session.snapshot().B.floor.ready], [true, true]);
  const signsBefore = client.marketReqs.length;
  await session.buyAtFloor('A');
  check('a loaded press sends without signing first', client.marketReqs.length - signsBefore, 1); // the 1 is the refill behind it
  check('nothing was signed inline', session.snapshot().recent.some((e) => /signed inline/.test(e.text)), false);
  session.close();
}

{
  // Nothing offered under the cap: killed, free, position untouched.
  const client = clientWithResponses([{ success: true, orderId: '0xk', status: 'live', makingAmount: '0', takingAmount: '0' }]);
  const session = makeSession(client, 0);
  gameLooksOver(session);
  const result = await session.buyAtFloor('B');
  check('nothing under the cap: killed, position unchanged', [result?.verdict, session.snapshot().B.shares], ['killed', 0]);
  session.close();
}

{
  // 0.1c on a 0.01 market would have to round UP to 1c — declined instead.
  const client = clientWithResponses([floorFill]);
  const session = makeSession(client, 0);
  (session as any).book.top = () => null;
  await session.buyAtFloor('B');
  check('a tick too coarse for the cap sends nothing', client.posts, 0);
  check('and stamps why', /lowest price is 1c/.test(session.snapshot().lastAction?.detail ?? ''), true);
  check('the HUD is told it declines', session.snapshot().B.floor.maxPrice, null);
  session.close();
}

{
  // His box says 1c: on a 0.01 market that prices.
  const client = clientWithResponses([floorFill]);
  const session = makeSession(client, 0);
  (session as any).book.top = () => null;
  (session as any).config.floorBuyCapCents = 1;
  await session.buyAtFloor('B');
  check('1c on a 0.01 market sends at 0.01', client.marketReqs[0]?.maxPrice, 0.01);
  session.close();
}

{
  const client = clientWithResponses([floorFill]);
  const session = makeSession(client, 0);
  gameLooksOver(session);
  (session as any).config.dryRun = true;
  await session.buyAtFloor('B');
  check('dry run sends nothing', client.posts, 0);
  check('dry run still stamps', session.snapshot().lastAction?.outcome, 'dry');
  session.close();
}

{
  const client = clientWithResponses([floorFill]);
  const session = makeSession(client, 0);
  gameLooksOver(session);
  (session as any).config.floorBuyNotional = 9_999;
  await session.buyAtFloor('B');
  check('above maxNotionalPerOrder: nothing sent', client.posts, 0);
  check('above the cap is stamped blocked', session.snapshot().lastAction?.outcome, 'blocked');
  session.close();
}

{
  const client = clientWithResponses([floorFill]);
  const session = makeSession(client, 0);
  (session as any).market = null;
  await session.buyAtFloor('A');
  check('no market armed is stamped', session.snapshot().lastAction?.detail, 'no market armed');
  session.close();
}

globalThis.fetch = originalFetch;
console.log(failures ? `\n${failures} FAILURES\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
