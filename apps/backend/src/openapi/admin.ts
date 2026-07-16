/**
 * Admin section of the OpenAPI spec — schemas + path
 * registrations for `/api/admin/*` (the staff-only ops surface:
 * treasury snapshot, pending payouts, cashback-config CRUD,
 * per-merchant + per-user drill metrics, audit tail, CSV
 * exports, etc.).
 *
 * Sixth per-domain module of the openapi.ts decomposition (after
 * #1153 auth, #1154 merchants, #1155 orders, #1156 users, #1157
 * public).
 *
 * Shared dependencies passed in:
 * - `errorResponse` — registered ErrorResponse from openapi.ts
 *   shared components.
 * - `loopAssetCode` — LOOP-asset code enum (USDLOOP / GBPLOOP /
 *   EURLOOP). Defined inline in openapi.ts because Users uses it
 *   too — passing in keeps the spec byte-identical without
 *   duplicating the schema.
 * - `payoutState` — pending_payouts lifecycle enum (pending /
 *   submitted / confirmed / failed). Same cross-section share as
 *   loopAssetCode.
 * - `cashbackPctString` — `numeric(5,2)`-as-string percentage
 *   schema. Shared with the Merchants section's bulk
 *   cashback-rate response.
 *
 * Every admin schema + path is preserved verbatim — every per-
 * route description, per-status response wiring, and per-section
 * divider is kept intact so the generated OpenAPI document stays
 * content-identical.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerAdminCashbackConfigOpenApi } from './admin-cashback-config.js';
import { registerAdminCreditWritesOpenApi } from './admin-credit-writes.js';
import { registerAdminUserWritesOpenApi } from './admin-user-writes.js';
import { registerAdminRailsOpenApi } from './admin-rails.js';
import { registerAdminAccountHoldsOpenApi } from './admin-account-holds.js';
import { registerAdminCsvExportsOpenApi } from './admin-csv-exports.js';
import { registerAdminDashboardClusterOpenApi } from './admin-dashboard-cluster.js';
import { registerAdminFleetMonthlyOpenApi } from './admin-fleet-monthly.js';
import { registerAdminMiscReadsOpenApi } from './admin-misc-reads.js';
import { registerAdminOpsTailOpenApi } from './admin-ops-tail.js';
import { registerAdminOperatorFleetOpenApi } from './admin-operator-fleet.js';
import { registerAdminOperatorMixOpenApi } from './admin-operator-mix.js';
import { registerAdminOrderClusterOpenApi } from './admin-order-cluster.js';
import { registerAdminVaultRecoveryOpenApi } from './admin-vault-recovery.js';
import { registerAdminPayoutsClusterOpenApi } from './admin-payouts-cluster.js';
import { registerAdminPerMerchantDrillOpenApi } from './admin-per-merchant-drill.js';
import { registerAdminPerUserDrillOpenApi } from './admin-per-user-drill.js';
import { registerAdminSupplierSpendOpenApi } from './admin-supplier-spend.js';
import { registerAdminTreasuryAssetsOpenApi } from './admin-treasury-assets.js';
import { registerAdminUserClusterOpenApi } from './admin-user-cluster.js';
import { registerAdminStaffOpenApi } from './admin-staff.js';
import { registerAdminSupportOpsOpenApi } from './admin-support-ops.js';

/**
 * Registers all `/api/admin/*` schemas + paths on the supplied
 * registry. Called once from openapi.ts during module init.
 */
// Cross-section enum schemas the admin factory pulls from openapi.ts.
// `z.record` constrains its key to a Zod schema whose output is a
// string-like — the exact `z.ZodEnum<...>` type generic in zod 4 is
// hard to spell from outside the construction site, so we widen to
// the runtime shape (`{ enum: object }`) and let the call sites narrow
// via the local PascalCase aliases below.
type ZodEnumLike = z.ZodEnum<{ readonly [key: string]: string | number }>;

export function registerAdminOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  loopAssetCode: ZodEnumLike,
  payoutState: ZodEnumLike,
  cashbackPctString: z.ZodTypeAny,
): void {
  // Local aliases for the cross-section enums passed in by openapi.ts.
  // Kept as PascalCase consts so every schema reference inside the
  // admin body (which previously read the inline definitions) stays
  // syntactically identical to the pre-decomposition source.
  const LoopAssetCode = loopAssetCode;
  const PayoutState = payoutState;
  const CashbackPctString = cashbackPctString;

  // ─── Admin treasury / asset-drift (ADR 009/011/013/015) ─────────────────────
  //
  // Three paths backing the ADR-015 ledger ↔ chain reconciliation
  // surface — /api/admin/treasury (snapshot),
  // /api/admin/assets/{assetCode}/circulation (per-asset drift),
  // /api/admin/asset-drift/state (watcher snapshot) — plus their
  // locally-scoped schemas (TreasurySnapshot,
  // AssetCirculationResponse, AssetDriftStateRow/Response, and
  // four inline composition helpers) live in
  // ./admin-treasury-assets.ts. Threaded deps: shared
  // `errorResponse`, `LoopAssetCode`, and `PayoutState`.
  registerAdminTreasuryAssetsOpenApi(registry, errorResponse, LoopAssetCode, PayoutState);

  const AdminPayoutView = registry.register(
    'AdminPayoutView',
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      orderId: z.string().uuid().nullable().openapi({
        description:
          'Source order id for `kind=order_cashback` and `kind=burn` payouts. NULL for emission payouts (ADR-024 §2 / ADR 036).',
      }),
      kind: z.enum(['order_cashback', 'emission', 'burn', 'interest_mint']).openapi({
        description:
          'Discriminator: `order_cashback` is the order-fulfilment payout; `emission` is the ADR-024 admin write re-scoped by ADR 036 (on-chain backfill, no mirror debit); `burn` is the ADR 036 redemption issuer-return; `interest_mint` is the ADR 031 nightly issuer-signed interest mint.',
      }),
      assetCode: z
        .string()
        .openapi({ description: 'LOOP asset code — USDLOOP / GBPLOOP / EURLOOP.' }),
      assetIssuer: z.string().openapi({ description: 'Stellar issuer account for this asset.' }),
      toAddress: z.string().openapi({ description: 'Destination Stellar address (user wallet).' }),
      amountStroops: z
        .string()
        .openapi({ description: 'Payout amount in stroops. BigInt as string.' }),
      memoText: z.string().openapi({
        description: 'Memo that memo-idempotency pre-check searches for on retry (ADR 016).',
      }),
      state: PayoutState,
      txHash: z.string().nullable(),
      lastError: z.string().nullable().openapi({
        description: 'Most recent submit error (classified kind from payout-submit).',
      }),
      attempts: z.number().int(),
      createdAt: z.string(),
      submittedAt: z.string().nullable(),
      confirmedAt: z.string().nullable(),
      failedAt: z.string().nullable(),
    }),
  );

  // ─── Admin ops tail (ADR 009/011/015/017/018) ──────────────────────────────
  //
  // Six residual paths that don't fit any topical cluster — discord
  // trio, top-users, audit-tail, merchants/resync — plus the
  // top-user / audit-tail schemas they need. Lifted into
  // ./admin-ops-tail.ts. Only `errorResponse` crosses the boundary.
  registerAdminOpsTailOpenApi(registry, errorResponse);

  // ─── Admin — credit-adjustment write (ADR 017) ─────────────────────────────

  const AdminWriteAudit = registry.register(
    'AdminWriteAudit',
    z.object({
      actorUserId: z.string().uuid(),
      actorEmail: z.string().email(),
      idempotencyKey: z.string(),
      appliedAt: z.string().datetime(),
      replayed: z.boolean(),
    }),
  );

  // ─── Admin credit-write surfaces (ADR 017/024 + A2-901) ─────────────────────
  //
  // The three admin-mediated writes — credit-adjustment, refund,
  // emission — share the ADR-017 contract (idempotency key,
  // reason, audit envelope). Lifted into ./admin-credit-writes.ts;
  // the nine locally-scoped Body/Result/Envelope schemas travel
  // with it. `AdminWriteAudit` stays here because it is shared
  // with ./admin-cashback-config.ts and is threaded into both
  // slices as a parameter.
  registerAdminCreditWritesOpenApi(registry, errorResponse, AdminWriteAudit);

  // Admin user-property writes — currently just the home-currency
  // flip (ADR 015 deferred). Same audit-envelope contract; lives
  // in its own slice because it isn't a credit/refund/emission.
  registerAdminUserWritesOpenApi(registry, errorResponse, AdminWriteAudit);

  // NS-04 — runtime rail kill switches: list + halt + resume for the
  // four money rails. Same ADR-017/028 audit-envelope contract on the
  // two writes; the list is a plain read.
  registerAdminRailsOpenApi(registry, errorResponse, AdminWriteAudit);

  // NS-08 — per-account freeze / AML-hold: place + release (admin-tier,
  // step-up, audited) + the two support-tier read lists. Same
  // ADR-017/028 audit-envelope contract on the two writes.
  registerAdminAccountHoldsOpenApi(registry, errorResponse, AdminWriteAudit);

  // ADR 037 — staff role management (admin-tier; step-up writes)
  // and the support-ops cluster (watcher-skip browser + reopen,
  // per-user wallet card + reprovision, redemption re-fetch,
  // reverse lookup — support-tier). Both share the AdminWriteAudit
  // envelope half for their ADR-017 action responses.
  registerAdminStaffOpenApi(registry, errorResponse, AdminWriteAudit);
  registerAdminSupportOpsOpenApi(registry, errorResponse, AdminWriteAudit);

  // ADR-028 / A4-063: admin step-up auth.
  const StepUpBody = registry.register(
    'AdminStepUpBody',
    z.object({
      otp: z.string().min(1).max(20).openapi({
        description:
          'OTP code received via POST /api/auth/request-otp. Phase-1 supports OTP only; Phase-2 widens to password / WebAuthn.',
      }),
      kind: z.literal('otp').optional().openapi({
        description: 'Reserved for ADR-028 Phase-2. Defaults to "otp".',
      }),
      // CF-08: optional action-class binding. Mirrors STEP_UP_SCOPES
      // in src/auth/admin-step-up.ts (kept inline so the spec module
      // stays free of runtime auth imports).
      scope: z
        .enum([
          'admin-write',
          'credit-adjustment',
          'refund',
          'withdrawal',
          'payout-retry',
          'payout-compensation',
          'home-currency',
          'operator-float',
        ])
        .optional()
        .openapi({
          description:
            'CF-08: action class to bind the minted token to. Omitted → the wildcard `admin-write` scope (satisfies every gate; backward-safe default). A narrower value binds the token to one destructive-write class so it cannot be replayed against a different one.',
        }),
    }),
  );
  const StepUpResponse = registry.register(
    'AdminStepUpResponse',
    z.object({
      stepUpToken: z.string().openapi({
        description:
          'JWT to send as `X-Admin-Step-Up` on destructive admin endpoints. 5-minute TTL. Hold in memory only — never localStorage.',
      }),
      expiresAt: z.string().datetime(),
    }),
  );
  registry.registerPath({
    method: 'post',
    path: '/api/admin/step-up',
    summary: 'Mint a 5-minute admin step-up token (ADR 028).',
    description:
      'Re-verifies the admin (currently via OTP) and returns a short-lived `X-Admin-Step-Up` JWT the admin must present on credit-adjust / refund / emission / payout-retry. Stateless — verified by HS256 signature against `LOOP_ADMIN_STEP_UP_SIGNING_KEY`. The bearer access token alone is insufficient by design — see ADR-028.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      body: { content: { 'application/json': { schema: StepUpBody } } },
    },
    responses: {
      200: {
        description: 'Step-up token minted',
        content: { 'application/json': { schema: StepUpResponse } },
      },
      400: {
        description: 'Invalid body (missing otp)',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Wrong OTP, expired, or wrong auth kind (Loop-native required)',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description:
          'Not found — also returned to authenticated non-admin callers: requireAdmin masks the admin surface as 404 by design (see src/auth/require-admin.ts).',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (30/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description:
          'Admin step-up not configured on this deployment (LOOP_ADMIN_STEP_UP_SIGNING_KEY unset)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Admin payouts cluster (ADR 015/016/017/024) ───────────────────────────
  //
  // Six paths backing /admin/payouts (list, single-row drill,
  // by-asset totals, settlement-lag SLA, retry, compensate) plus
  // their locally-scoped schemas live in
  // ./admin-payouts-cluster.ts. Threaded deps: shared
  // `errorResponse`, plus `PayoutState` (cross-section enum from
  // openapi.ts), `AdminPayoutView` (also reused by
  // ./admin-order-cluster.ts), and `AdminWriteAudit`.
  registerAdminPayoutsClusterOpenApi(
    registry,
    errorResponse,
    PayoutState,
    AdminPayoutView,
    AdminWriteAudit,
  );

  // ─── Admin dashboard cluster (ADR 009/011/013/015/016) ──────────────────────
  //
  // Six dashboard-grade signals (stuck-orders / stuck-payouts /
  // cashback-activity / cashback-realization{,/daily} /
  // merchant-stats) backing the /admin landing page. Twelve
  // locally-scoped schemas travel with the slice in
  // ./admin-dashboard-cluster.ts.
  registerAdminDashboardClusterOpenApi(registry, errorResponse);

  // ─── Admin — supplier spend (ADR 013 / 015) ────────────────────────────────

  const AdminSupplierSpendRow = registry.register(
    'AdminSupplierSpendRow',
    z.object({
      currency: z.string().length(3),
      count: z.number().int().min(0),
      faceValueMinor: z.string(),
      wholesaleMinor: z.string(),
      userCashbackMinor: z.string(),
      loopMarginMinor: z.string(),
      marginBps: z.number().int().nonnegative().max(10_000).openapi({
        description: 'loopMargin / faceValue × 10 000. Clamped [0, 10 000].',
      }),
    }),
  );

  // ─── Admin supplier-spend & treasury credit-flow (ADR 009/013/015) ──────────
  //
  // The "treasury-velocity triplet" — supplier spend, supplier-spend
  // activity, treasury credit-flow — lives in ./admin-supplier-spend.ts.
  // Locally-scoped schemas (AdminSupplierSpendResponse,
  // AdminSupplierSpendActivityDay/Response,
  // AdminTreasuryCreditFlowDay/Response) travel with the slice.
  // `AdminSupplierSpendRow` stays here because it is shared with
  // ./admin-operator-fleet.ts and is threaded into both slices as a
  // parameter.
  registerAdminSupplierSpendOpenApi(registry, errorResponse, AdminSupplierSpendRow);

  //
  // The three X × operator endpoints (merchants/{id}/operator-mix,
  // operators/{id}/merchant-mix, users/{id}/operator-mix) plus
  // their six locally-scoped schemas live in
  // ./admin-operator-mix.ts. Only `errorResponse` crosses the
  // slice boundary.
  registerAdminOperatorMixOpenApi(registry, errorResponse);

  // ─── Admin operator-fleet (ADR 013/015/022) ─────────────────────────────────
  //
  // Operator-stats / operator-latency / per-operator supplier-spend
  // / per-operator activity — the four paths backing the
  // /admin/operators dashboard. Lifted into ./admin-operator-fleet.ts;
  // the five locally-scoped schemas travel with it. Threaded deps:
  // shared `errorResponse` plus the upstream `AdminSupplierSpendRow`
  // (also reused by the fleet supplier-spend section, so passed in
  // by reference rather than re-declared).
  registerAdminOperatorFleetOpenApi(registry, errorResponse, AdminSupplierSpendRow);

  // ─── Admin user cluster (ADR 009/015/022) ───────────────────────────────────
  //
  // The six user-directory + per-user read paths (paginated
  // /users, /users/by-email, /users/top-by-pending-payout,
  // /users/{userId}, /users/{userId}/credits,
  // /users/{userId}/credit-transactions) plus their eight
  // locally-scoped schemas live in ./admin-user-cluster.ts.
  registerAdminUserClusterOpenApi(registry, errorResponse);

  // ─── Admin order cluster (ADR 010/011/015/019) ─────────────────────────────
  //
  // The four order-cluster read paths (orders/activity,
  // orders/payment-method-share, orders/{id}, orders/{id}/payout)
  // plus their three locally-scoped schemas (AdminOrderState,
  // AdminOrderPaymentMethod, AdminOrderView), and the A5-1
  // orders/{id}/redrive write, live in ./admin-order-cluster.ts. The
  // `AdminPayoutView` schema stays here because it has multiple call
  // sites; `AdminWriteAudit` too (the redrive write's envelope);
  // both threaded as parameters to the slice.
  registerAdminOrderClusterOpenApi(registry, errorResponse, AdminPayoutView, AdminWriteAudit);

  // ─── Admin — vault recovery (ADR 031 V7) ────────────────────────────────────
  //
  // The two vault-recovery writes (vault-emissions/{id}/redrive,
  // vault-redemptions/{id}/redrive) plus their locally-scoped schemas
  // live in ./admin-vault-recovery.ts.
  registerAdminVaultRecoveryOpenApi(registry, errorResponse, AdminWriteAudit);

  // ─── Admin — cashback-config schemas (ADR 011) ──────────────────────────────
  //
  // Schemas + paths lifted into ./admin-cashback-config.ts; the
  // factory call below registers both. See the section header at
  // the call site for the dep-threading rationale.
  registerAdminCashbackConfigOpenApi(registry, errorResponse, CashbackPctString, AdminWriteAudit);

  // ─── Admin — treasury + payouts (ADR 015) ───────────────────────────────────

  // The three CSV exports that originally lived here (payouts.csv,
  // audit-tail.csv, orders.csv) are now in ./admin-csv-exports.ts
  // alongside every other admin CSV registration — see the comment
  // above the appended block in that file.

  // ─── Admin — misc reads (merchant-flows / reconciliation / user-search) ─────
  //
  // Three independent ad-hoc admin reads that don't fit the per-
  // merchant or per-user drill triplet. Lifted as one slice into
  // ./admin-misc-reads.ts; the six locally-scoped schemas
  // (MerchantFlow + Response, ReconciliationEntry + Response,
  // AdminUserSearchResult + Response) travel with it.
  registerAdminMiscReadsOpenApi(registry, errorResponse);

  // ─── Admin — cashback-config CRUD (ADR 011) ─────────────────────────────────
  //
  // The five `/api/admin/merchant-cashback-configs*` paths plus
  // their six locally-scoped schemas (AdminCashbackConfig + List /
  // Envelope / Upsert body / History row + Response) live in
  // ./admin-cashback-config.ts. None of those schemas are
  // referenced anywhere else in admin.ts so the slice carries them
  // with it. Threaded deps are the shared `errorResponse`,
  // cross-section `cashbackPctString`, and the upstream
  // `AdminWriteAudit` envelope.

  // ─── Admin per-merchant drill (ADR 011/015/022) ─────────────────────────────
  //
  // Both the scalar batch (flywheel-stats / cashback-summary /
  // payment-method-share) and the time-series companions
  // (cashback-monthly / flywheel-activity / top-earners) live in
  // ./admin-per-merchant-drill.ts. The 11 locally-scoped schemas
  // travel with the slice; only `errorResponse` crosses the
  // boundary.
  registerAdminPerMerchantDrillOpenApi(registry, errorResponse);

  // ─── Admin per-user drill (ADR 009/015/022) ─────────────────────────────────
  //
  // Per-user axis of the ADR-022 triplet — three scalars that back
  // the /admin/users/:id drill page (flywheel-stats /
  // cashback-monthly / payment-method-share). Lifted into
  // ./admin-per-user-drill.ts; the four locally-scoped schemas
  // (AdminUserFlywheelStats, AdminUserCashbackMonthlyEntry/Response,
  // UserPaymentMethodShareResponse) plus the inline
  // PaymentMethodBucketShape constant travel with the slice.
  registerAdminPerUserDrillOpenApi(registry, errorResponse);

  // ─── Admin CSV exports (ADR 018 Tier-3) ─────────────────────────────────────
  //
  // Lifted into ./admin-csv-exports.ts so this file stays under the
  // soft cap. The CSV-export routes form a self-contained group
  // (text/csv body, no JSON schema, single shared dependency on
  // `errorResponse`) so the slice is safe to delegate without
  // reaching back into the admin-local schemas defined above.
  registerAdminCsvExportsOpenApi(registry, errorResponse);

  // ─── Admin fleet-wide monthly / daily (ADR 015/016) ─────────────────────────
  //
  // Lifted into ./admin-fleet-monthly.ts so admin.ts stays under the
  // soft cap. The 13 paths in that slice carry their own response
  // schemas (AdminPayoutsMonthlyEntry / Response, PerAssetPayoutAmount,
  // PayoutsActivityDay / Response) — none of those names are
  // referenced anywhere else in admin.ts, so the section is
  // self-contained modulo the shared `errorResponse` dependency.
  registerAdminFleetMonthlyOpenApi(registry, errorResponse);
}
