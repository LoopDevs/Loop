/**
 * Payout-submit idempotency lookups against Horizon (ADR 016).
 *
 * Two functions, both serving the "have we already sent this payout?"
 * question that the payout submit worker (and the pay-CTX hop) asks
 * before (re-)submitting an outbound payment:
 *
 *   - `getOutboundPaymentByTxHash` — AUTHORITATIVE. Given a tx hash we
 *     persisted at submit time, ask Horizon directly whether that exact
 *     transaction landed. No history window: it's a single
 *     `GET /transactions/{hash}`. This is the primary idempotency check
 *     for a re-picked row whose first submit recorded its hash.
 *
 *   - `findOutboundPaymentByMemo` — FALLBACK. When no persisted hash is
 *     available (a crash between sign and persist, or the legacy
 *     pay-CTX path that has no row to persist into), scan the operator
 *     account's outbound payments newest-first looking for a matching
 *     memo. Optionally also match amount + asset so a memo collision on
 *     the shared deposit+operator account can't converge blindly.
 *
 * CF-18 (v-payments P1-2): the deposit account == the operator account
 * (ADR 010), so the operator's `/payments` feed interleaves every
 * inbound user deposit with outbound payouts. A fixed page cap meant a
 * re-picked stuck payout whose prior tx had scrolled past the window
 * returned `null` → the worker re-submitted → double-pay. The durable
 * fix is `getOutboundPaymentByTxHash` (no window at all); the scan is
 * kept as a fallback and hardened (deeper default window + amount/asset
 * matching) for the cases that still rely on it.
 *
 * Co-located here (rather than alongside the inbound watcher's
 * `listAccountPayments` + `isMatchingIncomingPayment` in `./horizon.ts`)
 * because these are the only Horizon callers that own the
 * operator-account payout idempotency semantics, scan `order=desc`, and
 * exist for the payout-submit side rather than the payment-receive side.
 *
 * Re-exported from `./horizon.ts` so the wide network of import sites
 * (the payout submit worker, retry handler, tests) keeps resolving
 * against the historical path.
 */
import { z } from 'zod';
import { logger } from '../logger.js';
import { HorizonPaymentsResponse, horizonUrl, extractCursor } from './horizon.js';

const log = logger.child({ area: 'horizon' });

/** What the memo scan returns when it locates a prior outbound payment. */
export interface OutboundPaymentMatch {
  txHash: string;
  amount: string;
  assetCode: string | null;
}

/**
 * Minimal `GET /transactions/{hash}` shape. We only consume
 * `successful` (did the tx land in a closed ledger and succeed?). The
 * hash is unforgeable and bound to the exact operation set we signed,
 * so the transaction's own success flag is sufficient for the
 * authoritative "did THIS submit land" check.
 */
const HorizonTransactionResponse = z.object({
  hash: z.string(),
  successful: z.boolean(),
});

/**
 * AUTHORITATIVE idempotency check (CF-18). Looks up a specific
 * transaction hash on Horizon. Returns:
 *   - `{ landed: true }`  — the tx is in a closed ledger and succeeded.
 *     The payout did go out; the caller must NOT re-submit.
 *   - `{ landed: false }` — the tx is on chain but FAILED. Safe to
 *     re-submit (a failed tx moved no value).
 *   - `null`              — Horizon returned 404: the tx never reached a
 *     ledger (built+signed but the submit network call never landed it).
 *     Safe to re-submit.
 *
 * Throws only on a non-404 transport / schema error — those are
 * read-degraded states the caller must fail closed on (leave the row
 * untouched, retry next tick), exactly like the scan path.
 *
 * Has no history-window dependency: a single point lookup by hash,
 * independent of how many inbound deposits have interleaved since the
 * prior submit. This is why CF-18 persists the hash at submit time and
 * checks here first, removing the double-pay window for re-picks.
 */
export async function getOutboundPaymentByTxHash(
  txHash: string,
): Promise<{ landed: boolean } | null> {
  const url = new URL(`${horizonUrl()}/transactions/${encodeURIComponent(txHash)}`);
  const res = await fetch(url, {
    headers: { Accept: 'application/hal+json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) {
    // Never landed in a ledger — safe to (re-)submit.
    return null;
  }
  if (!res.ok) {
    log.error({ status: res.status, txHash }, 'Horizon getOutboundPaymentByTxHash request failed');
    throw new Error(`Horizon ${res.status} on /transactions/{hash}`);
  }
  const raw = await res.json();
  const parsed = HorizonTransactionResponse.safeParse(raw);
  if (!parsed.success) {
    log.error(
      { issues: parsed.error.issues, txHash },
      'Horizon /transactions/{hash} failed schema validation',
    );
    throw new Error('Horizon schema drift on /transactions/{hash}');
  }
  return { landed: parsed.data.successful };
}

export async function findOutboundPaymentByMemo(args: {
  account: string;
  to: string;
  memo: string;
  /**
   * CF-18 / P2-1: optional amount + asset match. When supplied, a
   * memo+from+to hit is only returned if its amount AND asset also
   * match. A record matching the memo but NOT the amount/asset is
   * treated as a non-match (scanning continues), so a memo collision on
   * the shared deposit+operator account can't surface the wrong prior
   * payment. Callers that need the strict "fail-closed on mismatch"
   * posture (pay-ctx) still inspect the returned amount/asset
   * themselves; this filter is a defence-in-depth complement.
   */
  expectedAmountStroops?: bigint;
  expectedAssetCode?: string | null;
  /**
   * Max pages to scan before giving up. Default 8, ~1600 records.
   * CF-18: deepened from 3 (~600). Because operator==deposit (ADR 010)
   * the feed interleaves every inbound deposit with outbound payouts, so
   * a modest deposit volume could push a recent payout out of a
   * 600-record window. 1600 buys substantially more headroom for the
   * fallback path; the authoritative `getOutboundPaymentByTxHash` is
   * what actually removes the window dependency for re-picks.
   */
  maxPages?: number;
}): Promise<OutboundPaymentMatch | null> {
  const maxPages = args.maxPages ?? 8;
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${horizonUrl()}/accounts/${args.account}/payments`);
    url.searchParams.set('limit', '200');
    // Walk newest-first so a fresh submit lands on page 1.
    url.searchParams.set('order', 'desc');
    url.searchParams.set('join', 'transactions');
    if (cursor !== undefined) url.searchParams.set('cursor', cursor);

    const res = await fetch(url, {
      headers: { Accept: 'application/hal+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.error(
        { status: res.status, url: url.toString() },
        'Horizon findOutboundPaymentByMemo request failed',
      );
      throw new Error(`Horizon ${res.status} on ${url.pathname}`);
    }
    const raw = await res.json();
    const parsed = HorizonPaymentsResponse.safeParse(raw);
    if (!parsed.success) {
      log.error(
        { issues: parsed.error.issues },
        'Horizon response failed schema validation (findOutboundPaymentByMemo)',
      );
      throw new Error('Horizon schema drift on /payments');
    }
    const records = parsed.data._embedded.records;
    for (const p of records) {
      if (p.type !== 'payment') continue;
      if (p.transaction_successful === false) continue;
      // Outbound-only: the operator account is both deposit and operator
      // (ADR 010), so half this feed is inbound user deposits.
      // `from === account` keeps the scan to payments WE sent. (Horizon
      // has no server-side `from` filter on the account-payments
      // endpoint, so we filter here.)
      if (p.from !== args.account) continue;
      if (p.to !== args.to) continue;
      if (p.transaction?.memo_type !== 'text') continue;
      if (p.transaction.memo !== args.memo) continue;
      const assetCode = p.asset_code ?? null;
      const amount = p.amount ?? '0';
      // CF-18 / P2-1: when the caller pins the expected amount + asset, a
      // memo+from+to hit that doesn't match them is NOT this payout —
      // skip it and keep scanning rather than converging blindly.
      if (args.expectedAssetCode !== undefined && assetCode !== args.expectedAssetCode) {
        continue;
      }
      if (args.expectedAmountStroops !== undefined) {
        const recordStroops = decimalToStroops(amount);
        if (recordStroops === null || recordStroops !== args.expectedAmountStroops) {
          continue;
        }
      }
      return { txHash: p.transaction_hash, amount, assetCode };
    }
    if (records.length === 0) return null;
    const nextHref = parsed.data._links?.next?.href;
    const nextCursor = nextHref !== undefined ? extractCursor(nextHref) : null;
    if (nextCursor === null) return null;
    cursor = nextCursor;
  }
  return null;
}

/**
 * Decimal-string XLM/asset amount → stroops (1 unit = 10^7 stroops) as
 * bigint. Returns null for a non-decimal or over-precise string so a
 * malformed Horizon amount is treated as a non-match (fail-closed).
 * Mirrors `orders/pay-ctx.ts#decimalToStroops` — kept local so this
 * module stays a leaf dependency of the order path, not the reverse.
 */
function decimalToStroops(s: string): bigint | null {
  const trimmed = s.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const parts = trimmed.split('.');
  const whole = parts[0] ?? '0';
  const frac = parts[1] ?? '';
  if (frac.length > 7) return null;
  const fracPadded = frac.padEnd(7, '0');
  return BigInt(whole) * 10_000_000n + BigInt(fracPadded);
}
