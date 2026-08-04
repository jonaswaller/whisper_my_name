/**
 * Standing (GTC) limit orders — orders that REST on the book until filled or
 * cancelled.
 *
 * Everything else in this app is FAK: it takes whatever is available and
 * cancels the remainder, so nothing ever rests and there is nothing to manage.
 * These are the opposite, which is why they come with cancellation and an
 * open-order list — a resting order he cannot see or cancel is a liability.
 *
 * One upside: a resting order makes him a MAKER, and makers are exempt from
 * Polymarket's ~250ms marketable-order hold.
 */

import { OrderSide } from '@polymarket/bindings';
import { roundToTick } from './sizing.ts';

export interface OpenOrder {
  orderId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  /** Shares originally requested. */
  size: number;
  /** Shares already filled. */
  filled: number;
  /** Shares still resting. */
  remaining: number;
  createdAt: number | null;
}

export interface LimitSellRequest {
  tokenId: string;
  /** Shares to sell. */
  shares: number;
  price: number;
  tickSize: number;
  minOrderSize: number;
}

export interface LimitResult {
  ok: boolean;
  orderId: string | null;
  /** Price actually submitted, after tick rounding and clamping. */
  price: number;
  shares: number;
  error?: string;
  /** Set when the requested price had to be adjusted to be legal. */
  adjusted?: string;
  raw?: unknown;
}

interface LimitClient {
  createLimitOrder(request: Record<string, unknown>): Promise<any>;
  postOrder(order: any): Promise<any>;
  cancelOrder(request: { orderId: string }): Promise<any>;
  cancelAll(): Promise<any>;
  listOpenOrders(request?: Record<string, unknown>): Promise<any>;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Highest price that can legally rest on this market.
 *
 * A share settles at $1, so $1 itself is not a real offer. Tick size decides
 * how close he can get: 0.999 on a 0.001 market, only 0.99 on a 0.01 one. Tick
 * varies per market and can even change mid-market, so it is always read from
 * the market rather than assumed.
 */
export function maxRestingPrice(tickSize: number): number {
  return roundToTick(1 - tickSize, tickSize, 'down');
}

/** Lowest legal resting price — one tick above zero. */
export function minRestingPrice(tickSize: number): number {
  return tickSize;
}

/**
 * Snap a requested price into the legal range for this market, reporting any
 * change so the UI can say why "99.9c" became 99c.
 */
export function clampPrice(
  requested: number,
  tickSize: number,
): { price: number; adjusted?: string } {
  const max = maxRestingPrice(tickSize);
  const min = minRestingPrice(tickSize);

  // Compare the REQUESTED price against the ceiling before rounding. Rounding
  // first would quietly land 0.999 on 0.99 for a 0.01 market and then report it
  // as a tick rounding — hiding the real reason, which is that this market
  // cannot price above 0.99 at all.
  if (requested > max + 1e-9) {
    return { price: max, adjusted: `capped at ${max} (tick ${tickSize})` };
  }
  if (requested < min - 1e-9) {
    return { price: min, adjusted: `raised to the ${min} minimum` };
  }

  const price = roundToTick(requested, tickSize, 'down');
  const rounded = Math.abs(price - requested) > 1e-9;
  return { price, adjusted: rounded ? `rounded to the ${tickSize} tick` : undefined };
}

/**
 * Place a GTC sell that rests until filled or cancelled.
 *
 * Omitting `expiration` is what makes it GTC; supplying one would make it GTD.
 */
export async function placeLimitSell(
  client: LimitClient,
  req: LimitSellRequest,
): Promise<LimitResult> {
  const { price, adjusted } = clampPrice(req.price, req.tickSize);

  if (req.shares < req.minOrderSize) {
    return {
      ok: false,
      orderId: null,
      price,
      shares: req.shares,
      error: `${req.shares} shares is below the venue minimum of ${req.minOrderSize}`,
    };
  }

  try {
    const signed = await client.createLimitOrder({
      tokenId: req.tokenId,
      side: OrderSide.SELL,
      price,
      size: req.shares,
    });
    const response = await client.postOrder(signed);

    const errorMsg = response?.errorMsg || response?.error_msg || response?.error;
    if (response?.success === false || errorMsg) {
      return {
        ok: false,
        orderId: null,
        price,
        shares: req.shares,
        error: String(errorMsg ?? 'rejected'),
        adjusted,
        raw: response,
      };
    }

    return {
      ok: true,
      orderId: response?.orderId ?? response?.orderID ?? response?.id ?? null,
      price,
      shares: req.shares,
      adjusted,
      raw: response,
    };
  } catch (err: any) {
    return {
      ok: false,
      orderId: null,
      price,
      shares: req.shares,
      error: err?.message ?? String(err),
      adjusted,
    };
  }
}

/**
 * Normalize whatever listOpenOrders returns.
 *
 * Field names are read across snake/camel variants on purpose: this list is
 * what tells him money is committed on the book, so an unexpected shape must
 * degrade to a visible row rather than an empty panel that reads as "nothing
 * resting".
 */
export function normalizeOpenOrder(raw: Record<string, any>): OpenOrder {
  const size = num(raw.originalSize ?? raw.original_size ?? raw.size);
  const filled = num(raw.sizeMatched ?? raw.size_matched ?? raw.filled ?? 0);
  const createdRaw = raw.createdAt ?? raw.created_at ?? raw.timestamp;
  const created = createdRaw ? Number(createdRaw) : null;

  return {
    orderId: String(raw.orderId ?? raw.orderID ?? raw.id ?? ''),
    tokenId: String(raw.tokenId ?? raw.asset_id ?? raw.assetId ?? ''),
    side: String(raw.side ?? 'SELL').toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
    price: num(raw.price),
    size,
    filled,
    remaining: Math.max(0, Number((size - filled).toFixed(6))),
    // Timestamps arrive in seconds or milliseconds depending on the endpoint.
    createdAt: created ? (created < 1e12 ? created * 1000 : created) : null,
  };
}

/** Pull the row array out of a page, whatever the SDK wraps it in. */
function rowsOf(page: any): Record<string, any>[] {
  if (Array.isArray(page)) return page;
  for (const key of ['data', 'items', 'results', 'orders']) {
    if (Array.isArray(page?.[key])) return page[key];
  }
  return [];
}

/**
 * List every resting order.
 *
 * `listOpenOrders` returns `Paginated<OpenOrder[]>` — an ASYNC ITERABLE of
 * pages, not an array. Treating it as an array yields nothing at all, and the
 * failure is silent: the UI reads "nothing resting" while orders are live on
 * the book. Verified against a real resting order.
 */
export async function listOpenOrders(
  client: LimitClient,
  tokenId?: string,
): Promise<OpenOrder[]> {
  const paginator: any = client.listOpenOrders(tokenId ? { tokenId } : {});
  const out: OpenOrder[] = [];

  // Plain array or promise-of-array, in case the SDK ever simplifies this.
  if (Array.isArray(paginator)) {
    return paginator.map((r) => normalizeOpenOrder(r)).filter((o) => o.orderId);
  }

  if (typeof paginator?.[Symbol.asyncIterator] === 'function') {
    for await (const page of paginator) {
      for (const row of rowsOf(page)) out.push(normalizeOpenOrder(row));
    }
  } else if (typeof paginator?.firstPage === 'function') {
    for (const row of rowsOf(await paginator.firstPage())) out.push(normalizeOpenOrder(row));
  } else {
    for (const row of rowsOf(await paginator)) out.push(normalizeOpenOrder(row));
  }

  return out.filter((o) => o.orderId);
}

export async function cancelOrder(
  client: LimitClient,
  orderId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await client.cancelOrder({ orderId });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function cancelAllOrders(
  client: LimitClient,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await client.cancelAll();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
