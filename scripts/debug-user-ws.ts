/**
 * Dump every raw event from the user channel, unfiltered.
 *
 * fills.ts saw nothing during a confirmed live fill, so before guessing at the
 * parsing we look at what the socket actually delivers.
 */

import { createSecureClient } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';

import { loadDotEnv, loadCredentials } from '../src/agent/env.ts';

const SECONDS = Number(process.argv[2] ?? 30);

loadDotEnv();
const creds = loadCredentials();

const client = await createSecureClient({
  signer: privateKey(creds.privateKey),
  wallet: creds.wallet,
});
console.log(`authenticated as wallet ${creds.wallet} (type ${client.account.walletType})`);

console.log('subscribing to { topic: "user" } ...');
const t0 = Date.now();
let handle: any;
try {
  handle = await client.subscribe([{ topic: 'user' }]);
  console.log(`subscribe() resolved in ${Date.now() - t0}ms`);
  console.log('handle keys:', Object.keys(handle ?? {}).join(', ') || '(none)');
  console.log('asyncIterator present:', typeof handle?.[Symbol.asyncIterator] === 'function');
} catch (err: any) {
  console.error('subscribe() THREW:', err?.message ?? err);
  process.exit(1);
}

console.log(`\nlistening ${SECONDS}s — trade in another terminal to generate events\n`);
const timer = setTimeout(() => {
  console.log(`\n--- ${SECONDS}s elapsed, ${count} events ---`);
  handle?.close?.();
  process.exit(0);
}, SECONDS * 1000);

let count = 0;
try {
  for await (const event of handle) {
    count += 1;
    const e = event as any;
    console.log(`[${Date.now() - t0}ms] #${count} topic=${e?.topic} type=${e?.type}`);
    console.log(JSON.stringify(event, null, 2).slice(0, 1200));
    console.log('---');
  }
  console.log('iterator ENDED on its own — the socket closed');
} catch (err: any) {
  console.error('iterator THREW:', err?.message ?? err);
}
clearTimeout(timer);
