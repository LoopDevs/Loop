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
 *
 * Exported so `./horizon-find-outbound.ts` can resolve the same URL
 * on the payout-submit idempotency side; not part of the public
 * client surface.
 */
export function horizonUrl(): string {
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

export const HorizonPaymentsResponse = z.object({
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
 *
 * Exported so `./horizon-find-outbound.ts` can reuse the same parse;
 * not part of the public client surface.
 */
export function extractCursor(href: string): string | null {
  try {
    const url = new URL(href);
    return url.searchParams.get('cursor');
  } catch {
    return null;
  }
}

// `findOutboundPaymentByMemo` (the ADR-016 payout-submit
// idempotency lookup — "have we already sent this memo to this
// address?") lives in `./horizon-find-outbound.ts`. Re-exported
// here so the wide network of import sites (payout submit
// worker, retry handler, tests) keeps resolving against
// `'../payments/horizon.js'`.
export { findOutboundPaymentByMemo } from './horizon-find-outbound.js';

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
