/**
 * Auth + signing smoke test. Signs orders locally and posts NOTHING.
 *
 * Run with no .env to exercise the path with a throwaway key:
 *   npx tsx scripts/verify-auth.ts
 *
 * Run with SIGNER_PRIVATE_KEY + POLYMARKET_WALLET_ADDRESS set to prove the real
 * account can authenticate and sign before any money is at risk. This is the
 * go/no-go: signature type is account-shaped and cannot be guessed, so we make
 * the venue tell us.
 */

import { createSecureClient } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { OrderSide, OrderType } from '@polymarket/bindings';

// Any liquid token works — we only inspect the signed payload, never send it.
const PROBE_TOKEN =
  '40472665679887425908378900626110398741048094992392767676262326176479189032482';

const WALLET_TYPE_NAMES: Record<number, string> = {
  0: 'EOA',
  1: 'POLY_PROXY (legacy Magic/Google)',
  2: 'GNOSIS_SAFE (legacy external signer)',
  3: 'DEPOSIT_WALLET (default since 2026-05-04)',
};

async function main(): Promise<void> {
  const envKey = process.env.SIGNER_PRIVATE_KEY;
  const usingThrowaway = !envKey;
  const pk = (envKey ?? generatePrivateKey()) as `0x${string}`;
  const signerAddress = privateKeyToAccount(pk).address;
  const wallet = process.env.POLYMARKET_WALLET_ADDRESS ?? signerAddress;

  console.log(usingThrowaway ? '\nmode: THROWAWAY KEY (no real account)' : '\nmode: REAL ACCOUNT');
  console.log(`signer:  ${signerAddress}`);
  console.log(`wallet:  ${wallet}`);

  const t0 = Date.now();
  const client = await createSecureClient({ signer: privateKey(pk), wallet });
  console.log(`\nauthenticated in ${Date.now() - t0}ms`);

  const account = client.account;
  console.log(`resolved signer:      ${account.signer}`);
  console.log(`resolved wallet:      ${account.wallet}`);
  console.log(
    `resolved wallet type: ${account.walletType} — ${WALLET_TYPE_NAMES[account.walletType] ?? 'unknown'}`,
  );

  // Sign across a spread of notionals and price caps. The 2-decimal maker rule
  // (order.rs:2497) is the one that silently rejects orders, so assert it here
  // rather than discovering it live.
  console.log('\nsigning FAK buys — checking makerAmount precision:');
  let violations = 0;
  for (const [amount, maxPrice] of [
    [50, 0.88],
    [250, 0.93],
    [1000, 0.99],
    [13.37, 0.63],
    [7.77, 0.51],
  ] as [number, number][]) {
    const started = Date.now();
    const order = await client.createMarketOrder({
      tokenId: PROBE_TOKEN,
      side: OrderSide.BUY,
      amount,
      maxPrice,
      orderType: OrderType.FAK,
    });
    const maker = Number(order.makerAmount) / 1e6;
    const taker = Number(order.takerAmount) / 1e6;
    const twoDp = Math.round(maker * 10000) % 100 === 0;
    if (!twoDp) violations += 1;
    console.log(
      `  $${String(amount).padStart(7)} @ ${maxPrice}  ->  maker $${maker.toFixed(4).padStart(10)}  ` +
        `taker ${taker.toFixed(2).padStart(9)}sh  implied ${(maker / taker).toFixed(4)}  ` +
        `${twoDp ? '2dp OK' : '2dp VIOLATION'}  sig=${order.signatureType}  ${Date.now() - started}ms`,
    );
  }

  console.log(
    violations === 0
      ? '\nPASS — SDK produces 2dp-clean makerAmounts; no manual lattice needed.'
      : `\nFAIL — ${violations} orders violate the 2-decimal maker rule; keep sizing.ts alignment.`,
  );
  if (usingThrowaway) {
    console.log('Note: throwaway key proves the signing path only, not his account shape.');
  }
}

main().catch((err) => {
  console.error('\nFAILED:', err?.message ?? err);
  if (err?.cause) console.error('cause:', err.cause);
  process.exit(1);
});
