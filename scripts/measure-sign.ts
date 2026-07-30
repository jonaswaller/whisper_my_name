/** Is signing local or a network round trip? Decides how vital presigning is. */
import { createSecureClient } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { OrderSide, OrderType } from '@polymarket/bindings';

const TOK = '40472665679887425908378900626110398741048094992392767676262326176479189032482';
const pk = generatePrivateKey();
const client = await createSecureClient({ signer: privateKey(pk), wallet: privateKeyToAccount(pk).address });

const times: number[] = [];
for (let i = 0; i < 12; i++) {
  const t = Date.now();
  await client.createMarketOrder({ tokenId: TOK, side: OrderSide.BUY, amount: 100, maxPrice: 0.9, orderType: OrderType.FAK });
  times.push(Date.now() - t);
}
times.sort((a, b) => a - b);
console.log('sign times ms:', times.join(' '));
console.log(`min=${times[0]} p50=${times[6]} max=${times[11]}`);
