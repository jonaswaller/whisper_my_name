/**
 * End-to-end test harness. Everything the hotkeys will do, driven from the CLI.
 *
 * Inspect only — resolves the market, streams the book, prints what each hotkey
 * would send. Places nothing:
 *   npx tsx scripts/trade.ts <polymarket-url>
 *
 * Fire one order for real. Requires BOTH flags, and defaults to a small size:
 *   npx tsx scripts/trade.ts <url> --fire A1 --live
 *   npx tsx scripts/trade.ts <url> --fire A1 --live --amount 5 --slippage 3
 *
 * --fire takes <side><tier>: A1 A2 A3 B1 B2 B3, or SA / SB to sell out.
 */

import { createSecureClient } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import { OrderSide, OrderType } from '@polymarket/bindings';
import { privateKeyToAccount } from 'viem/accounts';

import { loadDotEnv, loadCredentials } from '../src/agent/env.ts';
import { resolveEvent, defaultMarket, type ArmableMarket } from '../src/agent/market.ts';
import { BookFeed } from '../src/agent/book.ts';
import { FillFeed } from '../src/agent/fills.ts';
import { planBuy, planSell, isUnfillable } from '../src/agent/sizing.ts';
import { dispatch } from '../src/agent/executor.ts';
import { fetchPositions } from '../src/agent/positions.ts';

/** Placeholder tiers — these become editable fields in the HUD. */
const TIERS = [
  { label: 'small', notional: 50, slippageCents: 3 },
  { label: 'semi-big', notional: 250, slippageCents: 8 },
  { label: 'big', notional: 1000, slippageCents: 20 },
];
const SELL_SLIPPAGE_CENTS = 5;
/** Book older than this disables the unfillable veto (fails open, per AI_HANDOFF.md:139). */
const BOOK_FRESH_MS = 1_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  loadDotEnv();
  const creds = loadCredentials();
  const signerAddress = privateKeyToAccount(creds.privateKey).address;

  const url = process.argv[2];
  if (!url || url.startsWith('--')) {
    console.error('usage: npx tsx scripts/trade.ts <polymarket-url> [--fire A1 --live]');
    process.exit(1);
  }

  console.log(`\nsigner: ${signerAddress}   (from ${creds.sources.key})`);
  console.log(`wallet: ${creds.wallet}   (from ${creds.sources.wallet})`);

  const client = await createSecureClient({
    signer: privateKey(creds.privateKey),
    wallet: creds.wallet,
  });
  const WALLET_TYPES: Record<number, string> = {
    0: 'EOA',
    1: 'POLY_PROXY',
    2: 'GNOSIS_SAFE',
    3: 'DEPOSIT_WALLET',
  };
  console.log(
    `authenticated — wallet type ${client.account.walletType} (${WALLET_TYPES[client.account.walletType] ?? '?'})`,
  );

  const event = await resolveEvent(url);
  const wanted = arg('market');
  const market: ArmableMarket =
    (wanted ? event.markets.find((m) => m.slug === wanted || m.id === wanted) : undefined) ??
    defaultMarket(event);

  console.log(`\nevent:  ${event.title}`);
  console.log(`armed:  ${market.question}`);
  console.log(`  A = ${market.teamA.name}`);
  console.log(`  B = ${market.teamB.name}`);
  console.log(`  tick=${market.tickSize} minSize=${market.minOrderSize} negRisk=${market.negRisk}`);
  if (market.closed) console.log('  WARNING: this market is CLOSED');

  const tokens = { A: market.teamA.tokenId, B: market.teamB.tokenId };

  const fills = new FillFeed(client as any);
  fills.watch([tokens.A, tokens.B]);
  fills.on('fill', (f) =>
    console.log(
      `\n  >>> FILL ${f.side} ${f.size} @ ${f.price}${f.inverted ? '  (price inverted — merge match)' : ''}`,
    ),
  );
  fills.on('position', (p) =>
    console.log(`  position ${p.tokenId.slice(0, 8)}…: ${p.shares} sh @ avg ${p.avgPrice}`),
  );
  fills.on('error', (e) => console.log(`  [fills] ${e.message}`));
  await fills.start();

  // The user channel only reports fills that happen while connected, so seed
  // what he already holds before any sell hotkey can be pressed.
  try {
    const held = await fetchPositions(creds.wallet);
    for (const tokenId of [tokens.A, tokens.B]) {
      const p = held.get(tokenId);
      if (p) {
        fills.seed(tokenId, p.shares, p.avgPrice);
        console.log(`  seeded ${p.outcome}: ${p.shares} sh @ ${p.avgPrice} (mark ${p.curPrice})`);
      }
    }
  } catch (err: any) {
    console.log(`  [positions] seed failed: ${err.message}`);
  }

  const book = new BookFeed();
  book.on('error', (e) => console.log(`  [book] ${e.message}`));
  book.subscribe([tokens.A, tokens.B]);

  process.stdout.write('\nwaiting for book');
  for (let i = 0; i < 40 && !(book.top(tokens.A) && book.top(tokens.B)); i++) {
    process.stdout.write('.');
    await sleep(250);
  }
  console.log();

  const topA = book.top(tokens.A);
  const topB = book.top(tokens.B);
  if (!topA || !topB) {
    console.error('\nno book after 10s — market may be inactive.');
    process.exit(1);
  }

  console.log(`\n  ${market.teamA.name}:  bid ${topA.bid} x${topA.bidSize}   ask ${topA.ask} x${topA.askSize}`);
  console.log(`  ${market.teamB.name}:  bid ${topB.bid} x${topB.bidSize}   ask ${topB.ask} x${topB.askSize}`);

  console.log('\nwhat each hotkey would send right now:');
  for (const [side, top] of [['A', topA], ['B', topB]] as const) {
    for (const [i, tier] of TIERS.entries()) {
      const plan = planBuy({
        notional: tier.notional,
        bestAsk: top.ask,
        slippageCents: tier.slippageCents,
        tickSize: market.tickSize,
        minOrderSize: market.minOrderSize,
      });
      const dead = top.ageMs <= BOOK_FRESH_MS && isUnfillable(top.ask, plan.maxPrice, market.tickSize);
      console.log(
        `  ${side}${i + 1}  $${String(tier.notional).padStart(5)} @ ${String(tier.slippageCents).padStart(2)}c` +
          `  ->  cap ${plan.maxPrice}  worst case ${plan.worstCaseShares} sh` +
          `${dead ? '  [VETO: unfillable]' : ''}${plan.warning ? `  (${plan.warning})` : ''}`,
      );
    }
  }

  const fire = arg('fire')?.toUpperCase();
  if (!fire) {
    console.log('\ninspect only — nothing sent. Add --fire A1 --live to place one order.');
    book.close();
    fills.close();
    return;
  }

  const live = has('live');
  const isSell = fire.startsWith('S');
  const sideKey = (isSell ? fire[1] : fire[0]) as 'A' | 'B';
  const tokenId = tokens[sideKey];
  const top = sideKey === 'A' ? topA : topB;
  if (!tokenId) {
    console.error(`\nbad --fire value: ${fire}`);
    process.exit(1);
  }

  let signArgs: any;
  let describe: string;

  if (isSell) {
    const position = fills.position(tokenId);
    if (position.shares <= 0) {
      console.error(`\nno position in ${sideKey} to sell.`);
      process.exit(1);
    }
    const plan = planSell({
      shares: position.shares,
      bestBid: top.bid,
      slippageCents: Number(arg('slippage') ?? SELL_SLIPPAGE_CENTS),
      tickSize: market.tickSize,
      minOrderSize: market.minOrderSize,
    });
    signArgs = {
      tokenId,
      side: OrderSide.SELL,
      shares: plan.shares,
      minPrice: plan.minPrice,
      orderType: OrderType.FAK,
    };
    describe = `SELL ${plan.shares} sh of ${sideKey}, floor ${plan.minPrice}`;
  } else {
    const tierIndex = Number(fire[1]) - 1;
    const tier = TIERS[tierIndex];
    if (!tier) {
      console.error(`\nbad tier in --fire ${fire} (use 1, 2 or 3)`);
      process.exit(1);
    }
    // Default the test to a small size; --amount overrides the tier.
    const notional = Number(arg('amount') ?? 5);
    const slippageCents = Number(arg('slippage') ?? tier.slippageCents);
    const plan = planBuy({
      notional,
      bestAsk: top.ask,
      slippageCents,
      tickSize: market.tickSize,
      minOrderSize: market.minOrderSize,
    });
    if (plan.warning) console.log(`\n  note: ${plan.warning}`);
    signArgs = {
      tokenId,
      side: OrderSide.BUY,
      amount: plan.amount,
      maxSpend: plan.amount, // all-in: the number shown is what leaves the balance
      maxPrice: plan.maxPrice,
      orderType: OrderType.FAK,
    };
    describe = `BUY $${plan.amount} of ${sideKey} (${sideKey === 'A' ? market.teamA.name : market.teamB.name}), cap ${plan.maxPrice}`;
  }

  console.log(`\n${live ? 'LIVE ORDER' : 'DRY RUN'}: ${describe}`);

  const signStart = Date.now();
  const signed = await client.createMarketOrder(signArgs);
  console.log(`signed in ${Date.now() - signStart}ms  (presigning removes this from the hot path)`);

  if (!live) {
    console.log('\ndry run — not sent. Signed payload:');
    console.log(`  maker ${signed.makerAmount}  taker ${signed.takerAmount}  type ${signed.orderType}  sig ${signed.signatureType}`);
    book.close();
    fills.close();
    return;
  }

  console.log('\nsending in 3s — ctrl-C to abort...');
  await sleep(3000);

  const result = await dispatch(client as any, signed, isSell ? 'SELL' : 'BUY');
  // Register before the fill can arrive, so a merge match is attributed to the
  // token we actually traded rather than the counterparty's leg.
  if (result.orderId) fills.expectOrder(result.orderId, tokenId);
  console.log(`\n  verdict:  ${result.verdict.toUpperCase()}`);
  console.log(`  order id: ${result.orderId ?? '(none)'}`);
  console.log(
    `  filled:   ${result.filledShares} sh ${isSell ? 'for' : 'costing'} $${result.spent}`,
  );
  console.log(`  avg px:   ${result.avgPrice ?? '(no fill)'}`);
  console.log(`  latency:  ${result.latencyMs}ms  (includes PM's ~250ms taker hold)`);
  if (result.error) console.log(`  error:    ${result.error}`);
  if (result.verdict === 'killed') {
    console.log('  (a kill costs nothing — no liquidity inside the cap)');
  }
  if (process.env.DEBUG_RAW) console.log('\nraw:', JSON.stringify(result.raw, null, 2));

  console.log('\nwatching the user channel for 8s to confirm the fill independently...');
  await sleep(8000);

  book.close();
  fills.close();
}

main().catch((err) => {
  console.error('\nFAILED:', err?.message ?? err);
  if (process.env.DEBUG_RAW && err?.stack) console.error(err.stack);
  process.exit(1);
});
