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

  // ─── Users — pending-payouts view (ADR 015 / 016) ──────────────────────────
  //
  // Registered down here (outside the Users schema block) so the `PayoutState`
  // enum from the Admin section is available. The shape is a trimmed subset of
  // `AdminPayoutView` — no `userId`, `toAddress`, or `memoText` because the
  // user already knows they're looking at their own account, and surfacing the
  // destination wallet / memo would expose internals without adding value.

  const UserPendingPayoutView = registry.register(
    'UserPendingPayoutView',
    z.object({
      id: z.string().uuid(),
      orderId: z.string().uuid().nullable().openapi({
        description:
          "Origin order id for order-fulfilment cashback payouts; null for kind='withdrawal' (A2-901 / ADR-024 §2).",
      }),
      assetCode: z
        .string()
        .openapi({ description: 'LOOP asset code — USDLOOP / GBPLOOP / EURLOOP.' }),
      assetIssuer: z.string().openapi({ description: 'Stellar issuer account for this asset.' }),
      amountStroops: z
        .string()
        .openapi({ description: 'Payout amount in stroops (7 decimals). BigInt as string.' }),
      state: payoutState,
      txHash: z.string().nullable().openapi({
        description: 'Confirmed Stellar tx hash — null until the payout is confirmed on-chain.',
      }),
      attempts: z.number().int(),
      createdAt: z.string().datetime(),
      submittedAt: z.string().datetime().nullable(),
      confirmedAt: z.string().datetime().nullable(),
      failedAt: z.string().datetime().nullable(),
    }),
  );

  const UserPendingPayoutsResponse = registry.register(
    'UserPendingPayoutsResponse',
    z.object({ payouts: z.array(UserPendingPayoutView) }),
  );

  const UserPendingPayoutsSummaryRow = registry.register(
    'UserPendingPayoutsSummaryRow',
    z.object({
      assetCode: z
        .string()
        .openapi({ description: 'LOOP asset code — USDLOOP / GBPLOOP / EURLOOP.' }),
      state: z.enum(['pending', 'submitted']),
      count: z.number().int().nonnegative(),
      totalStroops: z.string().openapi({
        description: 'Sum of `amount_stroops` in the bucket. BigInt as string.',
      }),
      oldestCreatedAt: z.string().datetime(),
    }),
  );

  const UserPendingPayoutsSummaryResponse = registry.register(
    'UserPendingPayoutsSummaryResponse',
    z.object({ rows: z.array(UserPendingPayoutsSummaryRow) }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/pending-payouts',
    summary: "Caller's on-chain payout rows (ADR 015 / 016).",
    description:
      "Returns the user's own `pending_payouts` rows — one row per outbound LOOP-asset payment tracked through its lifecycle (`pending → submitted → confirmed | failed`). Mirrors the admin endpoint's query shape (`?state=`, `?before=`, `?limit=`) but is scoped to the authenticated caller by `userId` — no admin-privileged cross-user access. Clients poll this from the wallet / cashback settings views while a payout is in flight.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        state: payoutState.optional().openapi({
          description: 'Filter to a single lifecycle state. Omitted → all states.',
        }),
        before: z
          .string()
          .datetime()
          .optional()
          .openapi({ description: 'ISO-8601 timestamp — return rows strictly older than this.' }),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .openapi({ description: 'Page size. Default 20, hard-capped at 100.' }),
      }),
    },
    responses: {
      200: {
        description: 'Payout rows, newest first',
        content: { 'application/json': { schema: UserPendingPayoutsResponse } },
      },
      400: {
        description: 'Invalid state or before',
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
    path: '/api/users/me/pending-payouts/summary',
    summary: "Caller's pending-payouts aggregate (ADR 015 / 016).",
    description:
      "Aggregate view of the caller's in-flight payouts bucketed by `(asset_code, state)`. One round-trip replaces paging the full list when a UI only needs the 'you have $X cashback settling' signal. Excludes `confirmed` rows (they're in the cashback history feed) and `failed` rows (they belong to the admin retry flow, not the user's in-flight view). Empty `rows` when the caller has no in-flight payouts.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'One row per (assetCode, state) bucket',
        content: { 'application/json': { schema: UserPendingPayoutsSummaryResponse } },
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

  const UserCashbackSummary = registry.register(
    'UserCashbackSummary',
    z.object({
      currency: z.string().length(3),
      lifetimeMinor: z.string(),
      thisMonthMinor: z.string(),
    }),
  );

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
    path: '/api/users/me/cashback-summary',
    summary: 'Compact lifetime + this-month cashback totals (ADR 009 / 015).',
    description:
      "Two-number headline the home / cashback pages render: `lifetimeMinor` is all-time cashback earned, `thisMonthMinor` resets at 00:00 UTC on the 1st. Both filter to `type='cashback'` in the user's current `home_currency` — no cross-currency sum (rare multi-currency users see only their home-currency earnings; admin ledger has cross-currency detail). `bigint`-minor units as strings.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Cashback summary',
        content: { 'application/json': { schema: UserCashbackSummary } },
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

  const UserCashbackByMerchantRow = registry.register(
    'UserCashbackByMerchantRow',
    z.object({
      merchantId: z.string(),
      cashbackMinor: z.string(),
      orderCount: z.number().int().nonnegative(),
      lastEarnedAt: z.string().datetime(),
    }),
  );

  const UserCashbackByMerchantResponse = registry.register(
    'UserCashbackByMerchantResponse',
    z.object({
      currency: z.string().length(3),
      since: z.string().datetime(),
      rows: z.array(UserCashbackByMerchantRow),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/cashback-by-merchant',
    summary: 'Top cashback-earning merchants for the caller (ADR 009 / 015).',
    description:
      "Groups the caller's `credit_transactions` (type='cashback', filtered to `home_currency`) by the source order's `merchant_id`. Each row carries earned cashback (bigint-minor as string), distinct order count, and the most-recent ledger-row timestamp. Default window 180 days; server clamps `?since=` to 366d and `?limit=` to 50. Sorted cashback DESC, ties break on lastEarnedAt DESC. `merchantId` is the catalog slug — clients resolve display name via the merchant catalog rather than paying for another round-trip here.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional().openapi({
          description:
            'ISO-8601 lower bound on `created_at`. Defaults to 180d ago; capped at 366d.',
        }),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Top-N rows in the window, ordered by cashback DESC',
        content: { 'application/json': { schema: UserCashbackByMerchantResponse } },
      },
      400: {
        description: 'Invalid `since` (or window over 366d)',
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
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/cashback-monthly',
    summary: 'Last 12 months of cashback totals grouped by (month, currency).',
    description:
      "Time-axis aggregate of the caller's cashback ledger. `DATE_TRUNC('month', created_at AT TIME ZONE 'UTC')` → `(month, currency)` with `SUM(amount_minor)` filtered to `type='cashback'`. Fixed 12-month window (current UTC month + previous 11). Oldest-first so the bar chart renders left-to-right without a client reverse. Multi-currency safe — a user who moved regions gets both currency entries per month. `cashbackMinor` is bigint-as-string so fleet-wide sums don't truncate.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Monthly entries, oldest first',
        content: {
          'application/json': {
            schema: z.object({
              entries: z.array(
                z.object({
                  month: z.string().regex(/^\d{4}-\d{2}$/),
                  currency: z.string().length(3),
                  cashbackMinor: z.string(),
                }),
              ),
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
        description: 'Internal error computing the aggregate',
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

  // User-facing flywheel + rail-mix pivot endpoints (ADR 015 / 022).
  // These are the self-view counterparts to the admin per-user endpoints
  // — same shapes, keyed on auth context instead of path param.

  const UserFlywheelStats = registry.register(
    'UserFlywheelStats',
    z.object({
      currency: z.string().length(3).openapi({
        description:
          "Caller's home_currency — both numerator and denominator scoped to it so the ratio shares a denomination.",
      }),
      recycledOrderCount: z.number().int(),
      recycledChargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
      totalFulfilledCount: z.number().int(),
      totalFulfilledChargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/flywheel-stats',
    summary: 'Caller-scoped recycled-vs-total scalar (ADR 015).',
    description:
      "Powers the FlywheelChip on /orders and /settings/cashback. Answers the user's question: 'how much of my spend came back to me as cashback I then spent again?'. Home-currency-locked. Zero-recycled users get zeroed fields (not 404) — the chip self-hides on zero via client-side check.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Caller recycled-vs-total flywheel scalar',
        content: { 'application/json': { schema: UserFlywheelStats } },
      },
      401: {
        description: 'Missing or invalid bearer token',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  const UserPaymentMethodShareResponseUserSelf = registry.register(
    'UserPaymentMethodShareResponseSelf',
    z.object({
      currency: z.string().length(3),
      state: z.enum(['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired']),
      totalOrders: z.number().int(),
      byMethod: z.object({
        xlm: z.object({
          orderCount: z.number().int(),
          chargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
        }),
        usdc: z.object({
          orderCount: z.number().int(),
          chargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
        }),
        credit: z.object({
          orderCount: z.number().int(),
          chargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
        }),
        loop_asset: z.object({
          orderCount: z.number().int(),
          chargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
        }),
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/payment-method-share',
    summary: "Caller's own rail mix (ADR 010/015).",
    description:
      'User-facing self-view of the payment-method-share quartet (fleet / per-merchant / per-user admin / self). Powers the RailMixCard on /settings/cashback. Home-currency-locked. A 0% LOOP-asset share is the clearest nudge to pick LOOP at next checkout so cashback compounds.',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        state: z
          .enum(['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired'])
          .optional(),
      }),
    },
    responses: {
      200: {
        description: "Caller's own rail mix",
        content: {
          'application/json': { schema: UserPaymentMethodShareResponseUserSelf },
        },
      },
      400: {
        description: 'Invalid ?state',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer token',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/pending-payouts/{id}',
    summary: 'Caller-scoped single payout detail (ADR 015 / 016).',
    description:
      "Permalink for one of the caller's `pending_payouts` rows. The settings/cashback page deep-links each row so the user can share the URL with support when asking about a stuck payout. Cross-user access returns 404 (not 403) so payout ids aren't enumerable.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Payout row',
        content: { 'application/json': { schema: UserPendingPayoutView } },
      },
      400: {
        description: 'Missing or malformed id',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Payout not found (or owned by a different user)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
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
    path: '/api/users/me/orders/{orderId}/payout',
    summary: 'Per-order cashback settlement drill (ADR 015 / 016).',
    description:
      "For one of the caller's own orders, return the single pending-payout row tied to it. Mirror of the admin `/api/admin/orders/{orderId}/payout` but ownership-scoped: (orderId, userId) predicate guarantees cross-user access returns 404 (not 403), so order ids aren't enumerable. Powers the per-order settlement card on `/orders/:id` — users see Stellar-side state (pending / submitted / confirmed / failed) next to the gift-card redemption. Null result when the order has no payout row yet (pre-cashback, credit-only ledger, or order doesn't belong to the caller).",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ orderId: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Payout row for the order',
        content: { 'application/json': { schema: UserPendingPayoutView } },
      },
      400: {
        description: 'Missing or malformed orderId',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: "No payout row for this order (or order doesn't belong to caller)",
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resolving the user',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
