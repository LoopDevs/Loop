/**
 * Support-ops OpenAPI registrations (ADR 037 §4) — the
 * watcher-skip browser (+ reopen), the per-user wallet card
 * (+ reprovision), the redemption re-fetch, the reverse lookup, the
 * fleet-wide ledger browser (A5-8), and the per-subject audit
 * timeline (A5-7). Wire shapes live in `@loop/shared/admin-support-ops`.
 *
 * All nine paths are SUPPORT-tier (admin ⊇ support); the three
 * POST actions carry the ADR 017 envelope (Idempotency-Key +
 * reason) without the step-up header — they unstick deliveries,
 * they don't move money (ADR 037 matrix). The ledger browser and the
 * audit timeline are plain reads — no envelope, no mutation.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

export function registerAdminSupportOpsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminWriteAudit: ReturnType<OpenAPIRegistry['register']>,
): void {
  const actionHeaders = z.object({
    'idempotency-key': z.string().min(16).max(128).openapi({
      description: 'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
    }),
  });
  const actionBody = registry.register(
    'AdminSupportActionBody',
    z.object({
      reason: z.string().min(2).max(500).openapi({
        description: 'Why the re-drive is needed — lands in the Discord audit trail (ADR 017).',
      }),
    }),
  );

  // ─── Reverse lookup ────────────────────────────────────────────────────────

  const AdminLookupResponse = registry.register(
    'AdminLookupResponse',
    z.object({
      kind: z.enum(['order', 'payment_memo', 'stellar_address']),
      userId: z.string().uuid(),
      orderId: z.string().uuid().optional().openapi({
        description: 'Present for `order` and `payment_memo` lookups.',
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/lookup',
    summary: 'Reverse lookup — order id / payment memo / Stellar address → user (ADR 037).',
    description:
      'Classifies `q` by shape (uuid → order id; 20-char base32 → payment memo; G+55 base32 → Stellar address, checking wallet_address then the legacy stellar_address) and runs one index-backed query. Support-tier: the user-360 entry point.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        q: z.string().min(1).max(64),
      }),
    },
    responses: {
      200: {
        description: 'Match found',
        content: { 'application/json': { schema: AdminLookupResponse } },
      },
      400: {
        description: 'q missing or matches none of the three shapes',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Caller is not staff (concealment), or no match for a well-formed q',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Watcher skip rows ─────────────────────────────────────────────────────

  const WatcherSkipRow = registry.register(
    'AdminWatcherSkipRow',
    z.object({
      paymentId: z.string().openapi({ description: 'Horizon operation id (row PK).' }),
      memo: z.string(),
      orderId: z.string().uuid().nullable(),
      // Kept in sync with `WATCHER_SKIP_REASONS` (@loop/shared) by hand —
      // this registration predates that constant existing and doesn't
      // import it (openapi/ stays independent of the runtime schema
      // module graph). AUDIT-2 finding C review: this enum had already
      // drifted behind `order_gone` (T0-1, #1526) before this PR; both
      // that and this PR's new `unrecognized_deposit` are added here.
      reason: z.enum([
        'asset_mismatch',
        'amount_insufficient',
        'missing_credit_row',
        'processing_error',
        'order_gone',
        'unrecognized_deposit',
      ]),
      status: z.enum(['pending', 'resolved', 'abandoned']),
      attempts: z.number().int(),
      lastError: z.string().nullable(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );
  const WatcherSkipsListResponse = registry.register(
    'AdminWatcherSkipsListResponse',
    z.object({ rows: z.array(WatcherSkipRow) }),
  );
  const WatcherSkipDetail = registry.register(
    'AdminWatcherSkipDetail',
    WatcherSkipRow.extend({
      payment: z.record(z.string(), z.unknown()).openapi({
        description: 'Parsed Horizon payment snapshot the retry sweep replays.',
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/watcher-skips',
    summary: 'List skipped-deposit rows (ADR 037 §4.4).',
    description:
      'Keyset-paginated browse of payment_watcher_skips (newest first; `before` cursor, same convention as /api/admin/orders). Filterable by `status` and `reason`. Support-tier.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        status: z.enum(['pending', 'resolved', 'abandoned']).optional(),
        reason: z
          .enum([
            'asset_mismatch',
            'amount_insufficient',
            'missing_credit_row',
            'processing_error',
            'order_gone',
            'unrecognized_deposit',
          ])
          .optional(),
        limit: z.string().optional().openapi({ description: '1-100, default 20.' }),
        before: z.string().optional().openapi({ description: 'ISO-8601 keyset cursor.' }),
      }),
    },
    responses: {
      200: {
        description: 'Skip rows, newest first',
        content: { 'application/json': { schema: WatcherSkipsListResponse } },
      },
      400: {
        description: 'Invalid status / reason / before',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Caller is not staff (concealment)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/watcher-skips/{paymentId}',
    summary: 'Skipped-deposit row detail incl. the Horizon payment snapshot.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ paymentId: z.string().regex(/^[0-9]{1,32}$/) }) },
    responses: {
      200: {
        description: 'Row + snapshot',
        content: { 'application/json': { schema: WatcherSkipDetail } },
      },
      400: {
        description: 'paymentId is not a Horizon operation id',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Caller is not staff (concealment), or no such row',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  const WatcherSkipReopenResult = registry.register(
    'AdminWatcherSkipReopenResult',
    z.object({
      paymentId: z.string(),
      priorStatus: z.literal('abandoned'),
      status: z.literal('pending'),
      attempts: z.number().int().openapi({ description: 'Reset to 0.' }),
    }),
  );
  const WatcherSkipReopenEnvelope = registry.register(
    'AdminWatcherSkipReopenEnvelope',
    z.object({ result: WatcherSkipReopenResult, audit: adminWriteAudit }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/admin/watcher-skips/{paymentId}/reopen',
    summary: 'Re-open an abandoned skip row for retry (ADR 037 support action).',
    description:
      'abandoned → pending with the attempt budget reset; the skip sweep re-evaluates the deposit on its next tick. Idempotent re-drive — refuses non-abandoned rows (`SKIP_NOT_ABANDONED`). ADR-017 envelope (Idempotency-Key + reason + Discord audit); support-tier, no step-up (no money moves). Runbook: deposit-skip-abandoned.md.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ paymentId: z.string().regex(/^[0-9]{1,32}$/) }),
      headers: actionHeaders,
      body: { content: { 'application/json': { schema: actionBody } } },
    },
    responses: {
      200: {
        description: 'Row reopened (or replayed from idempotency snapshot)',
        content: { 'application/json': { schema: WatcherSkipReopenEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid body, or malformed paymentId',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Caller is not staff (concealment), or no such row',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description: 'Row is not abandoned (`SKIP_NOT_ABANDONED`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Internal error (`INTERNAL_ERROR`), or unreadable replay snapshot (`IDEMPOTENCY_SNAPSHOT_CORRUPT`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Per-user wallet card ──────────────────────────────────────────────────

  const AdminUserWalletBalance = registry.register(
    'AdminUserWalletBalance',
    z.object({
      assetCode: z.string(),
      assetIssuer: z.string(),
      balanceStroops: z.string().openapi({ description: 'BigInt as string.' }),
      limitStroops: z.string().openapi({ description: 'BigInt as string.' }),
    }),
  );
  const AdminUserWalletResponse = registry.register(
    'AdminUserWalletResponse',
    z.object({
      userId: z.string().uuid(),
      provider: z.literal('privy').nullable(),
      walletId: z.string().nullable(),
      walletAddress: z.string().nullable(),
      stellarAddress: z.string().nullable().openapi({
        description: 'Legacy self-linked payout address (ADR 015).',
      }),
      provisioning: z.enum(['none', 'wallet_created', 'activated']),
      provisioningAttempts: z.number().int(),
      provisioningLastAttemptAt: z.string().datetime().nullable(),
      onChain: z
        .object({
          accountExists: z.boolean(),
          balances: z.array(AdminUserWalletBalance),
          asOf: z.string().datetime(),
        })
        .nullable()
        .openapi({
          description:
            'Null when Horizon was unreachable — no last-known-good fallback on the admin card.',
        }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/wallet',
    summary: 'User wallet card — provisioning state + on-chain balances (ADR 037 user-360).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ userId: z.string().uuid() }) },
    responses: {
      200: {
        description: 'Wallet state (onChain null on Horizon outage)',
        content: { 'application/json': { schema: AdminUserWalletResponse } },
      },
      400: {
        description: 'userId is not a uuid',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Caller is not staff (concealment), or no such user (`USER_NOT_FOUND`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  const WalletReprovisionResult = registry.register(
    'AdminWalletReprovisionResult',
    z.object({
      userId: z.string().uuid(),
      priorProvisioning: z.enum(['none', 'wallet_created']),
      attempts: z.number().int().openapi({ description: 'Reset to 0.' }),
      requeued: z.boolean(),
    }),
  );
  const WalletReprovisionEnvelope = registry.register(
    'AdminWalletReprovisionEnvelope',
    z.object({ result: WalletReprovisionResult, audit: adminWriteAudit }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/admin/users/{userId}/wallet/reprovision',
    summary: 'Re-enqueue wallet provisioning (ADR 037 support action).',
    description:
      'Resets the provisioning sweeper attempt budget and re-enqueues the signup-time provisioning drive (fire-and-forget after commit). Refuses already-activated wallets (`WALLET_ALREADY_ACTIVATED`). ADR-017 envelope; support-tier, no step-up. Runbook: wallet-provisioning-stuck.md.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      headers: actionHeaders,
      body: { content: { 'application/json': { schema: actionBody } } },
    },
    responses: {
      200: {
        description: 'Provisioning re-enqueued (or replayed from idempotency snapshot)',
        content: { 'application/json': { schema: WalletReprovisionEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid body, or non-uuid userId',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Caller is not staff (concealment), or no such user (`USER_NOT_FOUND`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description: 'Wallet already activated (`WALLET_ALREADY_ACTIVATED`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Internal error (`INTERNAL_ERROR`), or unreadable replay snapshot (`IDEMPOTENCY_SNAPSHOT_CORRUPT`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Redemption re-fetch ───────────────────────────────────────────────────

  const RefetchRedemptionResult = registry.register(
    'AdminRefetchRedemptionResult',
    z.object({
      orderId: z.string().uuid(),
      recovered: z.boolean(),
      hasCode: z.boolean().openapi({
        description: 'Field PRESENCE only — codes are gift-card money and are never echoed.',
      }),
      hasPin: z.boolean(),
      hasUrl: z.boolean(),
      attempts: z.number().int(),
    }),
  );
  const RefetchRedemptionEnvelope = registry.register(
    'AdminRefetchRedemptionEnvelope',
    z.object({ result: RefetchRedemptionResult, audit: adminWriteAudit }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/admin/orders/{orderId}/refetch-redemption',
    summary: 'One-shot redemption re-fetch for a fulfilled-null order (ADR 037 support action).',
    description:
      'Drives the redemption-backfill machinery once for this order — no backoff gate, no attempts cap (the action exists for sweeper-exhausted rows). Eligible: state=fulfilled, ctx_order_id present, all redemption fields NULL (`REDEMPTION_NOT_REFETCHABLE` otherwise). ADR-017 envelope; support-tier, no step-up. Runbook: redemption-backfill-exhausted.md.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ orderId: z.string().uuid() }),
      headers: actionHeaders,
      body: { content: { 'application/json': { schema: actionBody } } },
    },
    responses: {
      200: {
        description: 'Re-fetch ran — `recovered` says whether a payload landed',
        content: { 'application/json': { schema: RefetchRedemptionEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid body, or non-uuid orderId',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Caller is not staff (concealment), or no such order',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description: 'Order not eligible for a re-fetch (`REDEMPTION_NOT_REFETCHABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP — every call is a CTX round-trip)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Internal error (`INTERNAL_ERROR`), or unreadable replay snapshot (`IDEMPOTENCY_SNAPSHOT_CORRUPT`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Operator pool unavailable (`SERVICE_UNAVAILABLE`) — retry once CTX recovers',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Fleet-wide ledger browser (ADR 037 §4.2 / A5-8) ────────────────────────

  // Duplicated (not imported from `@loop/shared`) to match the
  // `openapi/admin-user-cluster-drill.ts` convention — openapi/ stays
  // independent of the runtime schema module graph. Mirrors the
  // CHECK constraint on `credit_transactions.type`.
  const LedgerCreditTransactionType = z
    .enum(['cashback', 'interest', 'spend', 'withdrawal', 'refund', 'adjustment'])
    .openapi({ description: 'Mirrors the CHECK constraint on credit_transactions.type.' });

  const AdminLedgerEntry = registry.register(
    'AdminLedgerEntry',
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      type: LedgerCreditTransactionType,
      amountMinor: z.string().openapi({
        description:
          'bigint-as-string, signed. Positive for cashback/interest/refund, negative for spend/withdrawal; adjustment can be either.',
      }),
      currency: z.string().length(3),
      referenceType: z.string().nullable(),
      referenceId: z.string().nullable(),
      createdAt: z.string().datetime(),
    }),
  );

  const AdminLedgerListResponse = registry.register(
    'AdminLedgerListResponse',
    z.object({ transactions: z.array(AdminLedgerEntry) }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/ledger',
    summary: 'Fleet-wide ledger browser — every user’s credit_transactions (ADR 037 §4.2 / A5-8).',
    description:
      'Newest-first, keyset-paginated (`?before=<iso>`, same convention as `/api/admin/orders`) browse of `credit_transactions` across every user — for drift investigation, dispute triage, and reconciliation without SQL. Filterable by `userId`, `type`, `referenceType`+`referenceId` together (e.g. `order`/`<uuid>` — REQUIRED as a pair, 400 if only one is set: either alone is not index-selective), and a `since`/`before` date range. `limit` clamps to [1, 200], default 50. Read-only: no mutation, no idempotency envelope. Every filter combination rides an index that already matches its predicate + the `created_at` ordering (composite `(user_id, created_at)` / `(type, created_at)` / an exact-match probe on both columns of `(reference_type, reference_id)`, or the plain `created_at` index for an unfiltered/date-range-only browse) so the query never degrades into an unbounded scan.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        userId: z.string().uuid().optional(),
        type: LedgerCreditTransactionType.optional(),
        referenceType: z
          .string()
          .regex(/^[a-z_]{1,64}$/)
          .optional(),
        referenceId: z.string().min(1).max(128).optional(),
        since: z.string().datetime().optional().openapi({ description: 'Inclusive lower bound.' }),
        before: z.string().datetime().optional().openapi({
          description:
            'Exclusive upper bound / keyset cursor — pass the last row’s createdAt to page older.',
        }),
        limit: z.coerce.number().int().min(1).max(200).optional().openapi({
          description: 'Default 50, clamped [1, 200].',
        }),
      }),
    },
    responses: {
      200: {
        description: 'Ledger rows (newest first)',
        content: { 'application/json': { schema: AdminLedgerListResponse } },
      },
      400: {
        description: 'Invalid userId / type / referenceType / referenceId / since / before / limit',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Caller is not staff (concealment)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the ledger',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Per-subject audit timeline (ADR 037 §4 / A5-7) ─────────────────────────

  const AdminAuditTimelineEvent = registry.register(
    'AdminAuditTimelineEvent',
    z.object({
      kind: z.enum(['admin_action', 'ledger', 'order', 'payout', 'session_revoked', 'auth_lock']),
      at: z.string().datetime().openapi({ description: 'Merge/sort key — newest first.' }),
      summary: z.string(),
      refType: z.enum(['order', 'payout']).nullable(),
      refId: z.string().nullable(),
      detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    }),
  );

  const AdminAuditTimelineCursors = registry.register(
    'AdminAuditTimelineCursors',
    z.object({
      adminActions: z.string().datetime().nullable(),
      ledger: z.string().datetime().nullable(),
      orders: z.string().datetime().nullable(),
      payouts: z.string().datetime().nullable(),
      sessions: z.string().datetime().nullable(),
    }),
  );

  const AdminUserAuditTimelineResponse = registry.register(
    'AdminUserAuditTimelineResponse',
    z.object({
      userId: z.string().uuid(),
      events: z.array(AdminAuditTimelineEvent),
      nextCursors: AdminAuditTimelineCursors,
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/audit',
    summary:
      'Per-subject audit timeline — admin actions + ledger + orders + payouts + sessions (ADR 037 §4 / A5-7).',
    description:
      "Merges five bounded, already-indexed per-user reads (admin_idempotency_keys rows naming this userId, credit_transactions, orders, pending_payouts, refresh_tokens revocations) plus a current-state OTP-lock snapshot into one newest-first timeline PAGE. `?limit=` bounds EACH source independently (default 8, clamped [1, 20]). Pagination is PER-SOURCE, not a single shared cursor: the response's `nextCursors` carries one `<iso|null>` cursor per source (the oldest `at` that source returned, or null when exhausted); the client echoes each non-null one back as `beforeAdminActions`/`beforeLedger`/`beforeOrders`/`beforePayouts`/`beforeSessions` to page THAT source older (a shared cursor would silently drop rows from denser sources). A request with NO before* param is page 1 (all sources + the OTP-lock snapshot); ANY before* param makes it a later page (only cursored sources re-queried, snapshot omitted). The admin-actions source only covers a trailing 24h window (admin_idempotency_keys is a 24h-TTL idempotency cache, hourly-swept — same limitation as the existing GET /api/admin/audit-tail); the OTP-lock entry is a snapshot of current state, not a history. Read-only — no mutation, no idempotency envelope. See admin/user-audit-timeline.ts for the full per-source doc.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      query: z.object({
        limit: z.coerce.number().int().min(1).max(20).optional().openapi({
          description: 'Per-source row cap. Default 8, clamped [1, 20].',
        }),
        beforeAdminActions: z.string().datetime().optional().openapi({
          description: 'Keyset cursor for the admin-actions source (its createdAt).',
        }),
        beforeLedger: z.string().datetime().optional().openapi({
          description: 'Keyset cursor for the ledger source (credit_transactions.createdAt).',
        }),
        beforeOrders: z.string().datetime().optional().openapi({
          description: 'Keyset cursor for the orders source (orders.createdAt).',
        }),
        beforePayouts: z.string().datetime().optional().openapi({
          description: 'Keyset cursor for the payouts source (pending_payouts.createdAt).',
        }),
        beforeSessions: z.string().datetime().optional().openapi({
          description: 'Keyset cursor for the sessions source (refresh_tokens.revokedAt).',
        }),
      }),
    },
    responses: {
      200: {
        description: 'Merged timeline page (newest first) + per-source next cursors',
        content: { 'application/json': { schema: AdminUserAuditTimelineResponse } },
      },
      400: {
        description: 'userId is not a uuid, or limit/before* is malformed',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Caller is not staff (concealment), or no such user',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
