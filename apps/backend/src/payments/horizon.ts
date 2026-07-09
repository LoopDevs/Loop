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
  // `type` discriminates the operation variant: `payment` /
  // `path_payment_strict_receive` / `path_payment_strict_send` /
  // `create_account` / `account_merge`. All three payment-shaped
  // types share the SAME destination-side field names Horizon uses
  // for a plain `payment` op — `to`, `asset_type`, `asset_code`,
  // `asset_issuer`, `amount` all describe what actually ARRIVED, not
  // what the sender routed through the DEX — so no extra parsing is
  // needed to read what a path payment delivered.
  //
  // AUDIT-2 finding C (2026-07): `isMatchingIncomingPayment` used to
  // gate on `p.type === 'payment'` alone, so a real user funding a
  // deposit via a path payment (a normal wallet auto-routing through
  // the DEX) was silently excluded — no match, no skip row, no
  // recovery trail, the Horizon cursor moved past it anyway. It now
  // also accepts `path_payment_strict_send` /
  // `path_payment_strict_receive`. `create_account` / `account_merge`
  // represent activation/merge XLM moves with their own field shapes
  // and stay excluded.
  type: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  // Optional: `create_account` and `account_merge` records don't
  // emit it. Prior to this relaxation the schema rejected those
  // records and threw "Horizon schema drift on /payments", marking
  // the entire watcher tick failed even though those ops are
  // harmless. The first-ever payment in the deposit account's
  // history is the createAccount that activated it — locking the
  // schema to require `asset_type` made bootstrap impossible.
  asset_type: z.string().optional(),
  asset_code: z.string().optional(),
  asset_issuer: z.string().optional(),
  amount: z.string().optional(),
  // Path-payment SOURCE-side fields (AUDIT-2 finding C). Present only
  // on `path_payment_strict_send` / `path_payment_strict_receive`
  // ops; captured so an `unrecognized_deposit` skip row's snapshot
  // shows what the sender actually routed IN, not just what arrived
  // (the `asset_*` / `amount` fields above already cover the
  // destination side, identically to a plain `payment` op — see the
  // `type` comment). Not consumed by any matching logic today —
  // reconciliation context only.
  source_asset_type: z.string().optional(),
  source_asset_code: z.string().optional(),
  source_asset_issuer: z.string().optional(),
  source_amount: z.string().optional(),
  // create_account-only fields: present when activating the
  // account. Captured so a future log line or test can introspect
  // the bootstrap event.
  starting_balance: z.string().optional(),
  account: z.string().optional(),
  funder: z.string().optional(),
  transaction_hash: z.string(),
  transaction_successful: z.boolean().optional(),
  transaction: HorizonTransaction.optional(),
});

export type HorizonPayment = z.infer<typeof HorizonPayment>;

// Exported for the skipped-deposit retry sweep
// (`./skipped-payments.ts`), which re-parses jsonb snapshots of
// payment records through the same schema before replaying them.
export const HorizonPaymentSchema = HorizonPayment;

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

// The ADR-016 payout-submit idempotency lookups
// (`findOutboundPaymentByMemo` — "have we already sent this memo to
// this address?" — and `getOutboundPaymentByTxHash` — the CF-18
// authoritative "did THIS tx land?" point lookup) live in
// `./horizon-find-outbound.ts`. Re-exported here so the wide network of
// import sites (payout submit worker, retry handler, tests) keeps
// resolving against `'../payments/horizon.js'`.
export {
  findOutboundPaymentByMemo,
  getOutboundPaymentByTxHash,
  type OutboundPaymentMatch,
} from './horizon-find-outbound.js';

/**
 * Ergonomic guard: "is this payment a successful, incoming payment
 * to `account` of asset `assetCode` / `assetIssuer`, with a text
 * memo?". The watcher uses this before consulting the orders table.
 *
 * `assetCode = null` asks for native XLM. Otherwise matches the
 * pair on a credit asset (typically USDC) — and a credit-asset match
 * REQUIRES `assetIssuer` to be pinned (see the AUDIT-2 note below).
 */
export function isMatchingIncomingPayment(
  p: HorizonPayment,
  opts: {
    account: string;
    assetCode: string | null;
    assetIssuer?: string;
  },
): boolean {
  // AUDIT-2 finding C: accept the two path-payment op types alongside
  // a plain `payment` — see the `type` field comment above for why no
  // extra field-reading is needed (the destination-side fields are
  // named identically across all three).
  if (
    p.type !== 'payment' &&
    p.type !== 'path_payment_strict_send' &&
    p.type !== 'path_payment_strict_receive'
  ) {
    return false;
  }
  if (p.transaction_successful === false) return false;
  if (p.transaction?.successful === false) return false;
  if (p.to !== opts.account) return false;
  if (p.transaction?.memo_type !== 'text') return false;
  if (typeof p.transaction.memo !== 'string' || p.transaction.memo.length === 0) return false;
  if (opts.assetCode === null) {
    return p.asset_type === 'native';
  }
  // AUDIT-2 finding A: a credit-asset match REQUIRES a pinned
  // issuer. Stellar asset codes are not unique — anyone can
  // self-issue an asset called "USDC" (or any LOOP-asset code) from
  // their own account. The previous clause here was
  // `opts.assetIssuer === undefined || p.asset_issuer ===
  // opts.assetIssuer`, which is vacuously true when no issuer is
  // passed — an unconfigured LOOP_STELLAR_USDC_ISSUER matched an
  // attacker's worthless self-issued "USDC" exactly as readily as
  // Circle's real asset, and the watcher would markOrderPaid +
  // procure a real gift card against it. Mirror the LOOP-asset
  // allowlist's posture instead (credits/payout-asset.ts:
  // configuredLoopPayableAssets omits any code whose issuer isn't
  // configured, so the watcher's LOOP-asset loop never even offers
  // an issuer-less candidate) — no issuer configured means NO
  // MATCH, never "any issuer".
  if (opts.assetIssuer === undefined) return false;
  return (
    (p.asset_type === 'credit_alphanum4' || p.asset_type === 'credit_alphanum12') &&
    p.asset_code === opts.assetCode &&
    p.asset_issuer === opts.assetIssuer
  );
}

/**
 * AUDIT-2 finding C: true when `p` is an operation that DELIVERS value
 * to `account` — a successful `payment` / `path_payment_strict_send` /
 * `path_payment_strict_receive` operation addressed `to === account` —
 * regardless of asset or memo.
 *
 * Deliberately independent of `isMatchingIncomingPayment` above (which
 * additionally requires an asset/memo match against a specific rail).
 * The watcher uses THIS narrower "did value land here" check to decide
 * whether a payment that matched NO configured rail is a genuine
 * unrecognized inbound deposit (record it for manual reconciliation —
 * INV-6, no stranded value) or just one of the SAME account's routine
 * OUTBOUND operator payments/payouts, which also appear in this feed
 * and also fail every rail match (`to !== account`) — the deposit
 * address IS the operator account (ADR 010), so both directions share
 * one Horizon `/payments` stream. Recording outbound traffic here would
 * flood `payment_watcher_skips` with noise on every routine payout.
 *
 * Edge (harmless, documented): a self-payment `from === account &&
 * to === account` classifies as inbound here (`to === account` holds).
 * No net value moves besides the network fee, so at worst it records an
 * `unrecognized_deposit` row an operator can dismiss — never a
 * mispaid order — and the operator never sends itself memo-less dust in
 * normal operation. Not special-cased.
 */
export function isInboundDeliveryToAccount(p: HorizonPayment, account: string): boolean {
  if (
    p.type !== 'payment' &&
    p.type !== 'path_payment_strict_send' &&
    p.type !== 'path_payment_strict_receive'
  ) {
    return false;
  }
  if (p.transaction_successful === false) return false;
  if (p.transaction?.successful === false) return false;
  return p.to === account;
}
