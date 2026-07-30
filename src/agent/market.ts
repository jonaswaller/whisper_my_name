/**
 * Market resolution: a pasted Polymarket URL -> the two CLOB token IDs the
 * hotkeys bind to.
 *
 * One event URL fans out to a dozen markets (series winner, per-game winners,
 * totals, handicaps, prop bets), so the URL alone never identifies a single
 * tradeable pair. `resolveEvent` returns all of them, classified and ordered,
 * and the caller picks which one to arm.
 *
 * Verified against https://polymarket.com/esports/league-of-legends/lpl/lol-al-edg-2026-07-31
 */

const GAMMA = 'https://gamma-api.polymarket.com';

export type MarketKind = 'series' | 'game' | 'other';

export interface ArmableMarket {
  /** Gamma market id, stable across the event's life. */
  id: string;
  slug: string;
  /** Full question text, e.g. "LoL: Anyone's Legend vs EDward Gaming - Game 1 Winner". */
  question: string;
  kind: MarketKind;
  /** Game number when kind === 'game'. */
  gameNumber?: number;
  /** Outcome A — hotkeys 1-3 and 7. */
  teamA: Outcome;
  /** Outcome B — hotkeys 4-6 and 8. */
  teamB: Outcome;
  /** Selects the EIP-712 domain: neg-risk markets sign against a different exchange contract. */
  negRisk: boolean;
  /** Price increment. Limits must be rounded to this or the venue rejects the order. */
  tickSize: number;
  /** Venue minimum, denominated in shares. */
  minOrderSize: number;
  active: boolean;
  closed: boolean;
}

export interface Outcome {
  /** Display name, e.g. "Anyone's Legend". */
  name: string;
  /** CLOB token id — the uint256 the order is signed against. */
  tokenId: string;
}

export interface ResolvedEvent {
  title: string;
  slug: string;
  markets: ArmableMarket[];
}

/**
 * Pull the event slug out of a Polymarket URL.
 *
 * Accepts a full URL, a path, or a bare slug so paste-anything works:
 *   https://polymarket.com/esports/league-of-legends/lpl/lol-al-edg-2026-07-31
 *   /esports/league-of-legends/lpl/lol-al-edg-2026-07-31?tid=123
 *   lol-al-edg-2026-07-31
 */
export function parseEventSlug(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('empty market URL');

  // Strip protocol/host and any query or fragment, then take the last path segment.
  const withoutOrigin = trimmed.replace(/^https?:\/\/[^/]+/i, '');
  const path = withoutOrigin.split(/[?#]/)[0] ?? '';
  const segments = path.split('/').filter(Boolean);
  const slug = segments.length > 0 ? segments[segments.length - 1]! : trimmed;

  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
    throw new Error(`could not read a market slug from: ${input}`);
  }
  return slug;
}

/**
 * Gamma returns `outcomes` and `clobTokenIds` as JSON-encoded strings rather
 * than arrays. Tolerate both in case that ever changes.
 */
function parseJsonArray(value: unknown, field: string): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* fall through to the throw below */
    }
  }
  throw new Error(`market is missing a usable ${field}`);
}

function classify(marketSlug: string, eventSlug: string, question: string): {
  kind: MarketKind;
  gameNumber?: number;
} {
  if (marketSlug === eventSlug) return { kind: 'series' };

  // Per-game winner markets are slugged `<event>-gameN` and asked as "Game N Winner".
  const slugGame = /-game(\d+)$/i.exec(marketSlug);
  if (slugGame && /winner/i.test(question)) {
    return { kind: 'game', gameNumber: Number(slugGame[1]) };
  }
  return { kind: 'other' };
}

/**
 * Order for the arm picker: series first, then games ascending, then everything
 * else. He trades the moneyline markets and wants them at the top.
 */
function orderForPicker(a: ArmableMarket, b: ArmableMarket): number {
  const rank = (m: ArmableMarket) => (m.kind === 'series' ? 0 : m.kind === 'game' ? 1 : 2);
  const byKind = rank(a) - rank(b);
  if (byKind !== 0) return byKind;
  if (a.kind === 'game' && b.kind === 'game') {
    return (a.gameNumber ?? 0) - (b.gameNumber ?? 0);
  }
  return a.slug.localeCompare(b.slug);
}

/** Fetch an event and return every market on it that hotkeys could bind to. */
export async function resolveEvent(input: string, signal?: AbortSignal): Promise<ResolvedEvent> {
  const slug = parseEventSlug(input);

  const res = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`, { signal });
  if (!res.ok) {
    throw new Error(`Gamma lookup failed for "${slug}": HTTP ${res.status}`);
  }

  const events = (await res.json()) as unknown;
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error(`no Polymarket event matches "${slug}" — check the URL`);
  }

  const event = events[0] as Record<string, any>;
  const rawMarkets: Record<string, any>[] = Array.isArray(event.markets) ? event.markets : [];

  const markets: ArmableMarket[] = [];
  for (const m of rawMarkets) {
    let outcomes: string[];
    let tokenIds: string[];
    try {
      outcomes = parseJsonArray(m.outcomes, 'outcomes');
      tokenIds = parseJsonArray(m.clobTokenIds, 'clobTokenIds');
    } catch {
      // A market without a tradeable token pair can't be armed; skip rather than
      // fail the whole event.
      continue;
    }
    if (outcomes.length < 2 || tokenIds.length < 2) continue;

    const marketSlug = String(m.slug ?? '');
    const question = String(m.question ?? marketSlug);
    const { kind, gameNumber } = classify(marketSlug, slug, question);

    markets.push({
      id: String(m.id),
      slug: marketSlug,
      question,
      kind,
      gameNumber,
      teamA: { name: outcomes[0]!, tokenId: tokenIds[0]! },
      teamB: { name: outcomes[1]!, tokenId: tokenIds[1]! },
      negRisk: Boolean(m.negRisk),
      tickSize: Number(m.orderPriceMinTickSize ?? 0.01),
      minOrderSize: Number(m.orderMinSize ?? 5),
      active: Boolean(m.active),
      closed: Boolean(m.closed),
    });
  }

  if (markets.length === 0) {
    throw new Error(`event "${slug}" has no tradeable markets`);
  }

  markets.sort(orderForPicker);
  return { title: String(event.title ?? slug), slug, markets };
}

/**
 * Default selection for the arm picker: the series market if present, else the
 * lowest-numbered game that is still open.
 */
export function defaultMarket(event: ResolvedEvent): ArmableMarket {
  const open = event.markets.filter((m) => m.active && !m.closed);
  const pool = open.length > 0 ? open : event.markets;
  return pool.find((m) => m.kind === 'series') ?? pool[0]!;
}

// The CLI for this lives in scripts/resolve.ts — keeping top-level await out of
// library modules is what lets them bundle into Electron's CJS main process.
