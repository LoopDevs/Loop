/**
 * `findOutboundPaymentByMemo` — Horizon idempotency lookup
 * (ADR 016 payout submit).
 *
 * Lifted out of `./horizon.ts`. Asks Horizon "have we already sent
 * this memo to this address from this operator account?" — used by
 * the payout submit worker before re-submitting a `pending_payouts`
 * row, so a prior submit that landed async (and we lost the
 * response) doesn't get re-issued as a duplicate Stellar tx.
 *
 * Scan strategy: walk pages newest-first, stop on the first match.
 * For a just-submitted payout the match is typically on page 1.
 * Cap the walk at `maxPages` (default 3 × 200 records = ~600 payments
 * of lookback) — deeper history shouldn't be relevant for a payout
 * submitted in the last few minutes. Returns `null` when no match
 * found within the scan window.
 *
 * Co-located here (rather than alongside the inbound watcher's
 * `listAccountPayments` + `isMatchingIncomingPayment` in
 * `./horizon.ts`) because it's the only Horizon caller that scans
 * `order=desc`, owns the operator-account memo idempotency
 * semantics, and exists for the payout-submit side rather than the
 * payment-receive side.
 *
 * Re-exported from `./horizon.ts` so the wide network of import
 * sites (the payout submit worker, retry handler, tests) keeps
 * resolving against the historical path.
 */
import { logger } from '../logger.js';
import { HorizonPaymentsResponse, horizonUrl, extractCursor } from './horizon.js';

const log = logger.child({ area: 'horizon' });

export async function findOutboundPaymentByMemo(args: {
  account: string;
  to: string;
  memo: string;
  /** Max pages to scan before giving up. Default 3, ~600 records. */
  maxPages?: number;
}): Promise<{ txHash: string; amount: string; assetCode: string | null } | null> {
  const maxPages = args.maxPages ?? 3;
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
      if (p.from !== args.account) continue;
      if (p.to !== args.to) continue;
      if (p.transaction?.memo_type !== 'text') continue;
      if (p.transaction.memo !== args.memo) continue;
      return {
        txHash: p.transaction_hash,
        amount: p.amount ?? '0',
        assetCode: p.asset_code ?? null,
      };
    }
    if (records.length === 0) return null;
    const nextHref = parsed.data._links?.next?.href;
    const nextCursor = nextHref !== undefined ? extractCursor(nextHref) : null;
    if (nextCursor === null) return null;
    cursor = nextCursor;
  }
  return null;
}
