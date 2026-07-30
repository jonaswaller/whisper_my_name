/**
 * Credential loading.
 *
 * Accepts both the official SDK names and the bill_sheng_code names, so an
 * existing .env from that project works unchanged (its aliases are listed in
 * AI_HANDOFF.md:962).
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const KEY_ALIASES = ['SIGNER_PRIVATE_KEY', 'POLY_PRIVATE_KEY', 'PRIVATE_KEY'] as const;
const WALLET_ALIASES = [
  'POLYMARKET_WALLET_ADDRESS',
  'POLYMARKET_PROXY_ADDRESS',
  'POLY_PROXY_ADDRESS',
  'POLY_FUNDER',
] as const;

export interface Credentials {
  privateKey: `0x${string}`;
  /** The account wallet holding the funds. Equals the signer for a plain EOA. */
  wallet: string;
  /** Which alias each value came from — printed so a mix-up is visible. */
  sources: { key: string; wallet: string };
}

/** Load .env from the project root if present. Real env vars still win. */
export function loadDotEnv(root = process.cwd()): void {
  const path = resolve(root, '.env');
  if (!existsSync(path)) return;
  // Node 22 reads .env natively — no dependency needed.
  process.loadEnvFile(path);
}

function firstSet(names: readonly string[]): { value: string; name: string } | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return { value, name };
  }
  return null;
}

/**
 * A private key is 32 bytes and a wallet address is 20. They are easy to paste
 * into the wrong variable, and the failure is silent and expensive, so check
 * the shapes rather than letting the SDK fail obscurely later.
 */
export function loadCredentials(): Credentials {
  const key = firstSet(KEY_ALIASES);
  const wallet = firstSet(WALLET_ALIASES);

  if (!key) {
    throw new Error(`no private key found — set one of: ${KEY_ALIASES.join(', ')}`);
  }
  const privateKey = (key.value.startsWith('0x') ? key.value : `0x${key.value}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error(
      `${key.name} is not a 32-byte private key (expected 64 hex chars after 0x, got ${privateKey.length - 2})`,
    );
  }

  if (!wallet) {
    throw new Error(`no wallet address found — set one of: ${WALLET_ALIASES.join(', ')}`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet.value)) {
    throw new Error(
      `${wallet.name} is not a 20-byte address (expected 40 hex chars after 0x, got ${wallet.value.length - 2}). ` +
        `A 64-char value is a private key, not an address.`,
    );
  }

  return {
    privateKey,
    wallet: wallet.value,
    sources: { key: key.name, wallet: wallet.name },
  };
}
