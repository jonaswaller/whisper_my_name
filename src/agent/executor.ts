/**
 * Order dispatch — the hot path.
 *
 * Signing is deliberately NOT done here. It costs ~116ms measured
 * (scripts/measure-sign.ts), which is why orders are signed ahead of time and
 * this function does nothing but POST bytes that are already signed.
 *
 * The POST response is the authority on whether an order filled or was killed.
 * The user WebSocket cannot tell us: Polymarket emits nothing at all for FAK
 * kills (AI_HANDOFF.md:130, proven live). So we always read this response.
 */

/** Structurally typed: the SDK does not re-export SignedOrder by name. */
type SignedOrder = Parameters<PostingClient['postOrder']>[0];

export type Verdict = 'filled' | 'partial' | 'killed' | 'rejected';

export interface ExecutionResult {
  verdict: Verdict;
  orderId: string | null;
  /** Shares actually received. */
  filledShares: number;
  /** Dollars actually spent. */
  spent: number;
  /**
   * True average fill price. Derived as makingAmount/takingAmount, which
   * AI_HANDOFF.md:994 identifies as the authoritative figure for taker fills —
   * their locally-computed prices were observed inverted on merge matches.
   */
  avgPrice: number | null;
  /** Wall-clock from dispatch to response. Includes PM's ~250ms taker hold. */
  latencyMs: number;
  error?: string;
  /** Raw response, kept so unexpected shapes are diagnosable after the fact. */
  raw?: unknown;
}

interface PostingClient {
  postOrder(order: any): Promise<unknown>;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read the fill out of a POST response.
 *
 * Field names are read defensively across snake/camel variants: this response
 * is the single source of truth for whether real money moved, and a shape
 * change must degrade to "unknown" rather than silently report a zero fill.
 */
function interpret(response: any, side: 'BUY' | 'SELL', latencyMs: number): ExecutionResult {
  const orderId = response?.orderId ?? response?.orderID ?? response?.id ?? null;

  const success = response?.success;
  const errorMsg: string | undefined =
    response?.errorMsg || response?.error_msg || response?.error || undefined;

  if (success === false || (errorMsg && String(errorMsg).length > 0)) {
    return {
      verdict: 'rejected',
      orderId,
      filledShares: 0,
      spent: 0,
      avgPrice: null,
      latencyMs,
      error: String(errorMsg ?? 'order rejected'),
      raw: response,
    };
  }

  // making/taking are what the maker GIVES and TAKES, so they swap by side:
  //   BUY  -> making = USDC out,   taking = shares in
  //   SELL -> making = shares out, taking = USDC in
  // Assuming the BUY convention for both reported a live sell of 18 shares at
  // $0.15 as "2.7 shares at $6.67" — impossible on a venue capped at $1.
  const making = num(response?.makingAmount ?? response?.making_amount);
  const taking = num(response?.takingAmount ?? response?.taking_amount);
  const status = String(response?.status ?? '').toLowerCase();

  const filledShares = side === 'BUY' ? taking : making;
  // Dollars out on a buy; dollars in on a sell.
  const spent = side === 'BUY' ? making : taking;
  const avgPrice =
    filledShares > 0 ? Number((spent / filledShares).toFixed(6)) : null;

  let verdict: Verdict;
  if (filledShares <= 0) {
    // FAK with no liquidity inside the cap: killed, costs nothing.
    verdict = 'killed';
  } else if (status.includes('matched') || status.includes('filled')) {
    verdict = 'filled';
  } else {
    verdict = 'partial';
  }

  return { verdict, orderId, filledShares, spent, avgPrice, latencyMs, raw: response };
}

/**
 * POST a presigned order. This is everything that happens on a keypress.
 *
 * `side` is required because the response fields are side-dependent and the
 * signed order's own side field is not reliably echoed back.
 */
export async function dispatch(
  client: PostingClient,
  order: SignedOrder,
  side: 'BUY' | 'SELL',
): Promise<ExecutionResult> {
  const started = Date.now();
  try {
    const response = await client.postOrder(order);
    return interpret(response, side, Date.now() - started);
  } catch (err: any) {
    return {
      verdict: 'rejected',
      orderId: null,
      filledShares: 0,
      spent: 0,
      avgPrice: null,
      latencyMs: Date.now() - started,
      error: err?.message ?? String(err),
      raw: err?.response ?? err?.cause,
    };
  }
}
