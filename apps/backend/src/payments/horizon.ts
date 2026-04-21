/**
 * Minimal Stellar Horizon REST client (ADR 010 payment watcher).
 *
 * We don't need the full `@stellar/stellar-sdk` surface for the watcher
 * — it polls one endpoint (account payments) and matches on three
 * fields (asset, amount, memo). A narrow `fetch`-backed client stays
 * dep-free and keeps the bundle / audit surface small.
 *
 * One call: `listAccountPayments({ account, cursor?, limit? })` →
 * `{ records, nextCursor }`. Uses `join=transactions` so the memo
 * the watcher needs to match against is embedded on each record
 * without a second round-trip per payment.
 */
import { z } from 'zod';
import { logger } from '../logger.js';

const log = logger.child({ area: 'horizon' });

/**
 * Horizon URL for the network the watcher should read. Public Stellar
 * mainnet is the default; operators override for testnet via
 * `LOOP_STELLAR_HORIZON_URL`. Read directly from `process.env` so a
 * test can flip the URL without a module reload.
 */
function horizonUrl(): string {
  const v = process.env['LOOP_STELLAR_HORIZON_URL'];
  if (typeof v === 'string' && v.length > 0) return v;
  return 'https://horizon.stellar.org';
}

/**
 * Single payment-operation record as Horizon returns it. Fields not
 * relevant to the watcher (created_at, source_account, etc.) are
 * accepted but not typed — Zod's `.passthrough` isn't worth the
 * surface; we narrow strictly to what we consume.
 */
const HorizonTransaction = z.object({
  memo: z.string().optional(),
  memo_type: z.string().optional(),
  successful: z.boolean().optional(),
});

const HorizonPayment = z.object({
  id: z.string(),
  paging_token: z.string(),
  type: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  asset_type: z.string(),
  asset_code: z.string().optional(),
  asset_issuer: z.string().optional(),
  amount: z.string().optional(),
  transaction_hash: z.string(),
  transaction_successful: z.boolean().optional(),
  transaction: HorizonTransaction.optional(),
});

export type HorizonPayment = z.infer<typeof HorizonPayment>;

const HorizonPaymentsResponse = z.object({
  _embedded: z.object({
    records: z.array(HorizonPayment),
  }),
  _links: z
    .object({
      next: z.object({ href: z.string() }).optional(),
    })
    .optional(),
});

export interface ListPaymentsResult {
  records: HorizonPayment[];
  /** Cursor to resume from on the next call, or null when no next page. */
  nextCursor: string | null;
}

export interface ListPaymentsArgs {
  account: string;
  cursor?: string;
  /** Horizon caps at 200 per page. Default: 50 — small enough to stay responsive. */
  limit?: number;
  /** Millisecond timeout. Default 10s — Horizon responses are fast on a healthy cluster. */
  timeoutMs?: number;
}

/**
 * Fetches a page of payment operations involving `account`. Uses
 * `join=transactions` so each record carries the parent tx's memo
 * inline — the watcher needs that to match a deposit to an order.
 *
 * Throws on network / non-2xx / schema-drift — those are ops-level
 * incidents the watcher should back off on, not partial-success
 * states to swallow.
 */
export async function listAccountPayments(args: ListPaymentsArgs): Promise<ListPaymentsResult> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const url = new URL(`${horizonUrl()}/accounts/${args.account}/payments`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('order', 'asc');
  url.searchParams.set('join', 'transactions');
  if (args.cursor !== undefined) url.searchParams.set('cursor', args.cursor);

  const res = await fetch(url, {
    headers: { Accept: 'application/hal+json' },
    signal: AbortSignal.timeout(args.timeoutMs ?? 10_000),
  });
  if (!res.ok) {
    log.error({ status: res.status, url: url.toString() }, 'Horizon request failed');
    throw new Error(`Horizon ${res.status} on ${url.pathname}`);
  }
  const raw = await res.json();
  const parsed = HorizonPaymentsResponse.safeParse(raw);
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues }, 'Horizon response failed schema validation');
    throw new Error('Horizon schema drift on /payments');
  }
  const records = parsed.data._embedded.records;
  const nextHref = parsed.data._links?.next?.href;
  const nextCursor = nextHref !== undefined ? extractCursor(nextHref) : null;
  return { records, nextCursor };
}

/**
 * Pulls the `cursor` query param out of Horizon's `_links.next.href`.
 * Horizon responds with absolute URLs to the next page — we key the
 * watcher on the cursor alone so the base URL can change without
 * invalidating stored progress.
 */
function extractCursor(href: string): string | null {
  try {
    const url = new URL(href);
    return url.searchParams.get('cursor');
  } catch {
    return null;
  }
}

/**
 * Looks back through `account`'s payment history for an outbound
 * payment matching `{ to, memo }`. Returns the first match (most
 * recent when we scan `order=desc`) or null.
 *
 * Primary use: ADR 016 payout-submit idempotency — before
 * re-submitting a `pending_payouts` row, we ask Horizon "have we
 * already sent this memo to this address?". If yes, the prior
 * submit landed async; we converge to `confirmed` without issuing
 * a second tx.
 *
 * Scan strategy: walk pages newest-first, stop on the first match.
 * For a just-submitted payout the match is typically on page 1.
 * We cap the walk at `maxPages` (default 3 × 200 records =
 * ~600 payments of lookback) — deeper history shouldn't be relevant
 * for a payout submitted in the last few minutes. `null` when no
 * match found within the scan window.
 *
 * Throws only on the initial Horizon error / schema drift —
 * propagates up to the worker's try/catch, which classifies as
 * transient and retries next tick.
 */
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

/**
 * Ergonomic guard: "is this payment a successful, incoming payment
 * to `account` of asset `assetCode` / `assetIssuer`, with a text
 * memo?". The watcher uses this before consulting the orders table.
 *
 * `assetCode = null` asks for native XLM. Otherwise matches the
 * pair on a credit asset (typically USDC).
 */
export function isMatchingIncomingPayment(
  p: HorizonPayment,
  opts: {
    account: string;
    assetCode: string | null;
    assetIssuer?: string;
  },
): boolean {
  if (p.type !== 'payment') return false;
  if (p.transaction_successful === false) return false;
  if (p.transaction?.successful === false) return false;
  if (p.to !== opts.account) return false;
  if (p.transaction?.memo_type !== 'text') return false;
  if (typeof p.transaction.memo !== 'string' || p.transaction.memo.length === 0) return false;
  if (opts.assetCode === null) {
    return p.asset_type === 'native';
  }
  return (
    (p.asset_type === 'credit_alphanum4' || p.asset_type === 'credit_alphanum12') &&
    p.asset_code === opts.assetCode &&
    (opts.assetIssuer === undefined || p.asset_issuer === opts.assetIssuer)
  );
}
