/**
 * Position seeding from the Data API.
 *
 * The user WebSocket only reports fills that happen while it is connected, so
 * an app that just started has no idea what he already holds. Hotkeys 7 and 8
 * sell "the position", which means we must know it before the first keypress.
 *
 * This is also the top of the trust hierarchy in AI_HANDOFF.md:1087 — the PM UI
 * and data-api outrank locally-derived numbers, which were observed drifting on
 * merge matches.
 */

const DATA_API = 'https://data-api.polymarket.com';

export interface HeldPosition {
  tokenId: string;
  shares: number;
  avgPrice: number;
  /** Mark price at fetch time, for an immediate unrealized PnL figure. */
  curPrice: number;
  title: string;
  outcome: string;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Fetch all open positions for an account wallet, keyed by CLOB token id. */
export async function fetchPositions(
  wallet: string,
  signal?: AbortSignal,
): Promise<Map<string, HeldPosition>> {
  const res = await fetch(`${DATA_API}/positions?user=${encodeURIComponent(wallet)}`, { signal });
  if (!res.ok) throw new Error(`positions lookup failed: HTTP ${res.status}`);

  const rows = (await res.json()) as unknown;
  const out = new Map<string, HeldPosition>();
  if (!Array.isArray(rows)) return out;

  for (const row of rows as Record<string, any>[]) {
    const tokenId = String(row.asset ?? row.tokenId ?? row.token_id ?? '');
    const shares = num(row.size);
    // Dust rows linger after a full exit; treat them as flat.
    if (!tokenId || shares <= 1e-6) continue;

    out.set(tokenId, {
      tokenId,
      shares,
      avgPrice: num(row.avgPrice ?? row.avg_price),
      curPrice: num(row.curPrice ?? row.cur_price),
      title: String(row.title ?? ''),
      outcome: String(row.outcome ?? ''),
    });
  }
  return out;
}
