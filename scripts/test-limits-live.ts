/**
 * Live end-to-end test of the standing-order path. Real money, small size.
 *
 *   npx tsx scripts/test-limits-live.ts "<url>"            # inspect only
 *   npx tsx scripts/test-limits-live.ts "<url>" --live     # place real orders
 *
 * Sequence: buy a small position, rest a limit sell well above the market so it
 * cannot fill, read it back from the open-orders API, cancel it, then repeat for
 * the "at ask" and "at max" buttons. Everything is cancelled at the end.
 *
 * Prices are chosen so the resting orders should NOT fill during the test —
 * we are verifying the order lifecycle, not trying to trade.
 */

import { createSecureClient } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import { OrderSide, OrderType } from '@polymarket/bindings';

import { loadDotEnv, loadCredentials } from '../src/agent/env.ts';
import { resolveEvent, defaultMarket } from '../src/agent/market.ts';
import { BookFeed } from '../src/agent/book.ts';
import { fetchPositions } from '../src/agent/positions.ts';
import { planBuy } from '../src/agent/sizing.ts';
import { dispatch } from '../src/agent/executor.ts';
import {
  placeLimitSell,
  listOpenOrders,
  cancelOrder,
  cancelAllOrders,
  maxRestingPrice,
} from '../src/agent/limitOrders.ts';

const MAX_SPEND = 3;
const url = process.argv[2];
const LIVE = process.argv.includes('--live');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let step = 0;
const head = (s: string) => console.log(`\n─── ${++step}. ${s} ${'─'.repeat(Math.max(0, 52 - s.length))}`);
let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  if (!url) {
    console.error('usage: npx tsx scripts/test-limits-live.ts "<url>" [--live]');
    process.exit(1);
  }
  loadDotEnv();
  const creds = loadCredentials();
  const client: any = await createSecureClient({
    signer: privateKey(creds.privateKey),
    wallet: creds.wallet,
  });
  console.log(`\nwallet ${creds.wallet} (type ${client.account.walletType})`);
  console.log(LIVE ? 'MODE: LIVE — real orders' : 'MODE: inspect only');

  const event = await resolveEvent(url);
  const market = defaultMarket(event);
  console.log(`\n${event.title}\n  armed: ${market.question}`);

  const book = new BookFeed();
  book.subscribe([market.teamA.tokenId, market.teamB.tokenId]);
  for (let i = 0; i < 40; i++) {
    if (book.top(market.teamA.tokenId) && book.top(market.teamB.tokenId)) break;
    await sleep(250);
  }

  const tick = book.tickSize(market.teamA.tokenId) ?? market.tickSize;
  const topA = book.top(market.teamA.tokenId);
  const topB = book.top(market.teamB.tokenId);
  if (!topA || !topB) {
    console.error('\nno book — market may not be trading yet');
    process.exit(1);
  }
  console.log(`  live tick: ${tick}   (max resting price ${maxRestingPrice(tick)})`);
  console.log(`  ${market.teamA.name}: ${topA.bid}/${topA.ask}`);
  console.log(`  ${market.teamB.name}: ${topB.bid}/${topB.ask}`);

  // Cheaper side, so $3 clears the 5-share minimum.
  const useA = topA.ask <= topB.ask;
  const outcome = useA ? market.teamA : market.teamB;
  const top = useA ? topA : topB;
  console.log(`  testing on ${outcome.name} (ask ${top.ask}) — cheaper side fits the $${MAX_SPEND} cap`);

  if (!LIVE) {
    const plan = planBuy({ notional: MAX_SPEND, bestAsk: top.ask, slippageCents: 3, tickSize: tick, minOrderSize: market.minOrderSize });
    console.log(`\ninspect only. Would buy $${MAX_SPEND} at cap ${plan.maxPrice} (${plan.worstCaseShares} sh worst case)`);
    console.log(`Then rest sells at ${maxRestingPrice(tick)} and ${top.ask}, reading each back and cancelling.`);
    book.close();
    return;
  }

  // --- 1. get a position -----------------------------------------------------
  head('BUY a small position to sell against');
  let position = (await fetchPositions(creds.wallet)).get(outcome.tokenId);
  if (position && position.shares >= market.minOrderSize) {
    console.log(`   already holding ${position.shares} sh @ ${position.avgPrice} — reusing`);
  } else {
    const plan = planBuy({ notional: MAX_SPEND, bestAsk: top.ask, slippageCents: 5, tickSize: tick, minOrderSize: market.minOrderSize });
    const signed = await client.createMarketOrder({
      tokenId: outcome.tokenId, side: OrderSide.BUY,
      amount: plan.amount, maxSpend: plan.amount, maxPrice: plan.maxPrice,
      orderType: OrderType.FAK,
    });
    const res = await dispatch(client, signed, 'BUY');
    console.log(`   ${res.verdict}: ${res.filledShares} sh @ ${res.avgPrice} for $${res.spent} (${res.latencyMs}ms)`);
    check('buy filled', res.verdict === 'filled' || res.verdict === 'partial', res.error ?? '');
    if (res.filledShares <= 0) {
      console.log('\n   no position acquired — cannot test sells. Stopping.');
      book.close();
      process.exit(1);
    }
    // The Data API lags the fill — a single read 2.5s later returned 0 shares
    // for a position that had definitely filled. Poll until it appears.
    process.stdout.write('   waiting for the position to register');
    for (let i = 0; i < 15; i++) {
      await sleep(1500);
      process.stdout.write('.');
      position = (await fetchPositions(creds.wallet)).get(outcome.tokenId);
      if ((position?.shares ?? 0) >= market.minOrderSize) break;
    }
    console.log();
  }
  const shares = position?.shares ?? 0;
  console.log(`   position: ${shares} sh @ ${position?.avgPrice ?? '-'}`);
  if (shares < market.minOrderSize) {
    console.log(`\n   position ${shares} is under the ${market.minOrderSize} minimum — cannot rest a sell. Stopping.`);
    book.close();
    process.exit(1);
  }

  // --- 2. standing sell at max ----------------------------------------------
  head(`LIMIT SELL at max (${maxRestingPrice(tick)}) — should rest, not fill`);
  const atMax = await placeLimitSell(client, {
    tokenId: outcome.tokenId, shares, price: 0.999, // deliberately over-ask: must clamp
    tickSize: tick, minOrderSize: market.minOrderSize,
  });
  console.log(`   requested 0.999 -> placed at ${atMax.price}${atMax.adjusted ? `  (${atMax.adjusted})` : ''}`);
  check('order accepted', atMax.ok, atMax.error ?? '');
  check(`clamped to the ${tick} tick ceiling`, atMax.price === maxRestingPrice(tick), String(atMax.price));
  check('returned an order id', Boolean(atMax.orderId), String(atMax.orderId));

  // --- 3. read it back -------------------------------------------------------
  head('READ BACK from listOpenOrders');
  await sleep(1500);
  let open = await listOpenOrders(client);
  console.log(`   ${open.length} resting order(s)`);
  for (const o of open) {
    console.log(`     ${o.side} ${o.remaining}/${o.size} sh @ ${o.price}  id ${o.orderId.slice(0, 12)}…`);
  }
  const mine = open.find((o) => o.orderId === atMax.orderId);
  check('our order appears in the list', Boolean(mine));
  check('price parsed correctly', mine?.price === atMax.price, `got ${mine?.price}`);
  check('remaining size parsed', (mine?.remaining ?? 0) > 0, `got ${mine?.remaining}`);
  check('side parsed as SELL', mine?.side === 'SELL', String(mine?.side));
  check('token id parsed', mine?.tokenId === outcome.tokenId, (mine?.tokenId ?? '').slice(0, 14));

  // --- 4. cancel it ----------------------------------------------------------
  head('CANCEL that order');
  const cancelled = await cancelOrder(client, atMax.orderId!);
  check('cancel accepted', cancelled.ok, cancelled.error ?? '');
  await sleep(1500);
  open = await listOpenOrders(client);
  check('order is gone from the book', !open.some((o) => o.orderId === atMax.orderId), `${open.length} still resting`);

  // --- 5. sell at ask --------------------------------------------------------
  head(`LIMIT SELL at ASK (${top.ask}) — joins the offer queue`);
  const freshTop = book.top(outcome.tokenId) ?? top;
  const atAsk = await placeLimitSell(client, {
    tokenId: outcome.tokenId, shares, price: freshTop.ask,
    tickSize: tick, minOrderSize: market.minOrderSize,
  });
  console.log(`   placed at ${atAsk.price} (ask was ${freshTop.ask})`);
  check('order accepted', atAsk.ok, atAsk.error ?? '');
  check('priced exactly at the ask', atAsk.price === freshTop.ask, String(atAsk.price));

  // --- 6. clean up -----------------------------------------------------------
  head('CANCEL ALL — leave nothing resting');
  const all = await cancelAllOrders(client);
  check('cancel-all accepted', all.ok, all.error ?? '');
  await sleep(1500);
  open = await listOpenOrders(client);
  check('nothing left resting', open.length === 0, `${open.length} remain`);

  const finalPos = (await fetchPositions(creds.wallet)).get(outcome.tokenId);
  console.log(`\n   position still held: ${finalPos?.shares ?? 0} sh @ ${finalPos?.avgPrice ?? '-'}`);
  console.log(`   (sell it manually if you don't want to keep it)`);

  book.close();
  console.log(failures ? `\n${failures} FAILURES\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('\nFAILED:', err?.message ?? err);
  if (process.env.DEBUG_RAW && err?.stack) console.error(err.stack);
  process.exit(1);
});
