/**
 * Users section of the OpenAPI spec — schemas + path
 * registrations for `/api/users/me/*` (the caller-scoped self-
 * view surface: profile, cashback ledger, credits, trustlines,
 * pending payouts, flywheel stats, DSR exports).
 *
 * Fourth per-domain module of the openapi.ts decomposition (after
 * #1153 auth, #1154 merchants, #1155 orders).
 *
 * Shared dependencies passed in:
 * - `errorResponse` — registered ErrorResponse from openapi.ts
 *   shared components.
 * - `loopAssetCode` — LOOP-asset code enum (USDLOOP / GBPLOOP /
 *   EURLOOP). Defined inline in openapi.ts because the Admin
 *   section uses it too — passing it in keeps the spec byte-
 *   identical without duplicating the definition.
 * - `payoutState` — pending_payouts lifecycle enum (pending /
 *   submitted / confirmed / failed). Same cross-section share as
 *   loopAssetCode.
 *
 * Every schema + path is preserved verbatim (per-status response
 * descriptions, per-route comments, the cross-cutting note about
 * the pending-payouts schemas being declared down-section so the
 * PayoutState enum from Admin is available at the top of the
 * file). Generated spec is byte-identical to before this slice.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { STELLAR_PUBKEY_REGEX } from '@loop/shared';
import { registerUsersCashbackDrillOpenApi } from './users-cashback-drill.js';
import { registerUsersPendingPayoutsOpenApi } from './users-pending-payouts.js';

/**
 * Registers all `/api/users/me/*` schemas + paths on the
 * supplied registry. Called once from openapi.ts during module
 * init.
 */
export function registerUsersOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  loopAssetCode: z.ZodTypeAny,
  payoutState: z.ZodTypeAny,
): void {
  const UserMeView = registry.register(
    'UserMeView',
    z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      isAdmin: z.boolean(),
      homeCurrency: z.enum(['USD', 'GBP', 'EUR']).openapi({
        description:
          'Fiat the account is denominated in (ADR 015). Drives order pricing + the LOOP-asset cashback payout.',
      }),
      stellarAddress: z.string().nullable().openapi({
        description:
          "User's linked Stellar wallet for on-chain payouts. Null = unlinked; cashback accrues off-chain only.",
      }),
      homeCurrencyBalanceMinor: z.string().openapi({
        description:
          'Off-chain cashback balance in `homeCurrency` minor units (pence / cents), as a bigint-string so JSON round-trips don\'t truncate precision. `"0"` when the user has no ledger row yet (first-order users, pre-cashback).',
      }),
    }),
  );

  const SetHomeCurrencyBody = registry.register(
    'SetHomeCurrencyBody',
    z.object({
      currency: z.enum(['USD', 'GBP', 'EUR']),
    }),
  );

  const SetStellarAddressBody = registry.register(
    'SetStellarAddressBody',
    z.object({
      address: z.string().regex(STELLAR_PUBKEY_REGEX).nullable().openapi({
        description: 'Stellar public key (G…). Passing null unlinks the current wallet.',
      }),
    }),
  );

  const CashbackHistoryEntry = registry.register(
    'CashbackHistoryEntry',
    z.object({
      id: z.string().uuid(),
      type: z
        .enum(['cashback', 'interest', 'spend', 'withdrawal', 'refund', 'adjustment'])
        .openapi({ description: 'Ledger event kind — see `credit_transactions.type` (ADR 009).' }),
      amountMinor: z.string().openapi({
        description:
          'Pence / cents in `currency`, as a bigint-string. Positive for cashback / interest / refund, negative for spend / withdrawal, either for adjustment.',
      }),
      currency: z.string().length(3),
      referenceType: z.string().nullable().openapi({
        description: "Source tag, e.g. `'order'`. Null when support-adjusted directly.",
      }),
      referenceId: z.string().nullable().openapi({
        description: 'Matching reference id (e.g. order UUID).',
      }),
      createdAt: z.string().datetime(),
    }),
  );

  const CashbackHistoryResponse = registry.register(
    'CashbackHistoryResponse',
    z.object({ entries: z.array(CashbackHistoryEntry) }),
  );

  // ─── Users — credit balances (ADR 009 / 015) ────────────────────────────────

  const UserCreditRow = registry.register(
    'UserCreditRow',
    z.object({
      currency: z.string().length(3),
      balanceMinor: z.string().openapi({
        description: 'bigint-as-string. Minor units (pence / cents).',
      }),
      updatedAt: z.string().datetime(),
    }),
  );

  const UserCreditsResponse = registry.register(
    'UserCreditsResponse',
    z.object({ credits: z.array(UserCreditRow) }),
  );

  // ─── User profile (ADR 015) ──────────────────────────────────────────────────

  registry.registerPath({
    method: 'get',
    path: '/api/users/me',
    summary: 'Current user profile (ADR 015).',
    description:
      'Returns id / email / admin flag / home currency / linked Stellar address. Home currency drives order denomination + cashback-asset selection; the linked address is the destination for on-chain LOOP-asset payouts (null = off-chain accrual only).',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Profile', content: { 'application/json': { schema: UserMeView } } },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resolving the user',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/users/me/home-currency',
    summary: "Set the user's home currency (ADR 015).",
    description:
      'Onboarding-time picker. Writes `users.home_currency` when the user has zero orders. After the first order lands, the ledger is pinned to that currency and the endpoint returns 409 `HOME_CURRENCY_LOCKED` — support has a separate path to correct it.',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: SetHomeCurrencyBody } } } },
    responses: {
      200: {
        description: 'Updated profile',
        content: { 'application/json': { schema: UserMeView } },
      },
      400: {
        description: 'Validation error',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'User row disappeared between resolve + update',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description: 'HOME_CURRENCY_LOCKED — user has already placed orders',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resolving the user',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/users/me/stellar-address',
    summary: "Link or unlink the user's Stellar wallet (ADR 015).",
    description:
      'Pass a Stellar public key (G…) to opt into on-chain cashback payouts; pass `null` to unlink. Relinking is allowed at any time — the column is a routing hint, not a ledger-pinned value.',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: SetStellarAddressBody } } } },
    responses: {
      200: {
        description: 'Updated profile',
        content: { 'application/json': { schema: UserMeView } },
      },
      400: {
        description: 'Malformed Stellar pubkey',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'User row disappeared between resolve + update',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resolving the user',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  const StellarTrustlineRow = registry.register(
    'StellarTrustlineRow',
    z.object({
      code: loopAssetCode,
      issuer: z.string(),
      present: z.boolean(),
      balanceStroops: z.string(),
      limitStroops: z.string(),
    }),
  );

  const StellarTrustlinesResponse = registry.register(
    'StellarTrustlinesResponse',
    z.object({
      address: z.string().nullable(),
      accountLinked: z.boolean(),
      accountExists: z.boolean(),
      rows: z.array(StellarTrustlineRow),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/stellar-trustlines',
    summary: 'Caller-scoped LOOP-asset trustline check (ADR 015).',
    description:
      "Reads the caller's linked Stellar address on Horizon and reports which configured LOOP assets already have a trustline established. Lets the wallet UI warn 'your next USDLOOP payout will fail — add the trustline first' rather than surfacing a `op_no_trust` failed payout after the fact. Returns `accountLinked: false` with stub rows when the user hasn't linked a wallet; `accountExists: false` when the address isn't funded yet. 30s cache per address.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'One row per configured LOOP asset',
        content: { 'application/json': { schema: StellarTrustlinesResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (30/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resolving the user',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Horizon trustline check unavailable',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/cashback-history',
    summary: 'Recent credit-ledger events for the caller (ADR 009 / 015).',
    description:
      "Paginated cashback / interest / spend / withdrawal / refund / adjustment rows for the authenticated user. Page older rows with `?before=<iso-8601>`; cap the page size with `?limit=` (default 20, hard-capped at 100). Always scoped to the caller — admins use the separate `/api/admin/*` surfaces to inspect other users' ledgers.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .openapi({ description: 'Page size. Default 20, hard-capped at 100.' }),
        before: z
          .string()
          .datetime()
          .optional()
          .openapi({ description: 'ISO-8601 timestamp — return rows strictly older than this.' }),
      }),
    },
    responses: {
      200: {
        description: 'Ledger entries, newest first',
        content: { 'application/json': { schema: CashbackHistoryResponse } },
      },
      400: {
        description: 'Invalid before timestamp',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resolving the user',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/cashback-history.csv',
    summary: 'Full credit-ledger CSV export for the caller (ADR 009).',
    description:
      "One-shot CSV dump of the caller's credit-ledger history. Columns: Created (UTC), Type, Amount (minor), Currency, Reference type, Reference ID. Capped at 10 000 rows; the `X-Result-Count` response header reports the actual row count so the client can warn when the cap is hit. Tighter rate limit (6/min) than the JSON sibling because the query is unbounded in size.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description:
          'CSV attachment — Content-Disposition: attachment; filename="loop-cashback-history.csv".',
        content: { 'text/csv': { schema: z.string() } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (6/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resolving the user',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/credits',
    summary: 'Caller per-currency credit balance (ADR 009 / 015).',
    description:
      'Multi-currency complement to `/api/users/me`, which exposes only the home-currency scalar. Returns one row per non-zero `user_credits` currency — useful after a home-currency flip leaves a residual balance, or when support credits a user in a non-home currency. Empty `credits` when the user has never earned / has fully redeemed.',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Per-currency balances',
        content: { 'application/json': { schema: UserCreditsResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resolving the user',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Users pending-payouts cluster (ADR 015/016/024) ───────────────────────
  //
  // The four caller-scoped pending-payouts paths
  // (/pending-payouts list + /summary, /pending-payouts/{id},
  // and the nested /orders/{orderId}/payout lookup) plus their
  // four locally-scoped schemas (UserPendingPayoutView/Response,
  // UserPendingPayoutsSummaryRow/Response) live in
  // ./users-pending-payouts.ts. Threaded deps: shared
  // `errorResponse` and `payoutState`.
  registerUsersPendingPayoutsOpenApi(registry, errorResponse, payoutState);

  // ─── Users — cashback drill (ADR 009/010/015/022) ──────────────────────────
  //
  // Five caller-side cashback views — summary, by-merchant,
  // monthly, flywheel-stats, payment-method-share — plus their
  // four locally-scoped schemas live in
  // ./users-cashback-drill.ts. Only `errorResponse` crosses the
  // boundary.
  registerUsersCashbackDrillOpenApi(registry, errorResponse);

  registry.registerPath({
    method: 'post',
    path: '/api/users/me/dsr/delete',
    summary: 'A2-1905: self-serve account deletion (DSR / GDPR right of erasure).',
    description:
      "Anonymises the calling user — email replaced with a synthetic placeholder, OAuth identity links deleted, refresh tokens revoked. Ledger rows (`credit_transactions` / `orders` / `pending_payouts`) are RETAINED for tax / regulatory compliance per ADR 009 (append-only) but no longer link to a real person. Refuses with 409 + a typed `code` (`PENDING_PAYOUTS` or `IN_FLIGHT_ORDERS`) when there's money / fulfilment in flight — see `apps/backend/src/users/dsr-delete.ts` module header for the full posture.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Account anonymised — caller session is invalidated',
        content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description: 'Pre-condition failed: pending payout or in-flight order',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (3/hour per IP — destructive)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error during anonymisation',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/dsr/export',
    summary: 'A2-1906: self-serve data export (DSR / GDPR portability).',
    description:
      "Returns every database row Loop holds keyed to the calling user — `users` row, `user_identities`, `user_credits`, `credit_transactions`, `orders`, `pending_payouts`. Versioned schema envelope (`schemaVersion: 1`). Gift card redeem codes / PINs are deliberately excluded — `redeemIssued: boolean` reports whether one was issued, the secret material stays in the in-app order view. Off-host data sources (CTX gift card detail, backend access logs, Sentry events, Discord audit) require a `privacy@loopfinance.io` request — listed in the response's `notes.excluded`. `Content-Disposition: attachment` so the browser saves the JSON directly.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Data export envelope',
        content: { 'application/json': { schema: z.object({}).passthrough() } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'User row no longer exists (rare — race with hard delete)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (5/hour per IP — non-trivial multi-table scan)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error building the export',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/orders/summary',
    summary: "Compact 5-number summary of the caller's orders (ADR 010 / 015).",
    description:
      "Single query with FILTER-ed COUNT + SUM so the /orders page header renders without hitting the list endpoint. `pendingCount` groups `pending_payment` + `paid` + `procuring` — all 'in flight' from the user's perspective. `failedCount` groups `failed` + `expired`. `totalSpentMinor` is `SUM(charge_minor)` over `state = 'fulfilled'` only so pending / failed orders don't inflate lifetime spend. Home-currency locked — cross-currency detail stays admin-only.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: '5-number summary',
        content: {
          'application/json': {
            schema: z.object({
              currency: z.string().length(3),
              totalOrders: z.number().int().min(0),
              fulfilledCount: z.number().int().min(0),
              pendingCount: z.number().int().min(0),
              failedCount: z.number().int().min(0),
              totalSpentMinor: z.string(),
            }),
          },
        },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the summary',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
