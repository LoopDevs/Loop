/**
 * NS-08 — admin / AML account-freeze OpenAPI registration.
 *
 * Registers the four `/api/admin/.../holds` paths (place + release +
 * per-user list + live-holds dashboard) plus their locally-scoped
 * schemas. Re-invoked from `registerAdminOpenApi`. Mirrors the
 * ADR-017/028-shaped body / headers / envelope pattern of
 * `./admin-rails.ts`.
 *
 * Admin-namespace response invariants (openapi-parity): every path
 * declares 401 / 404 / 500 and 429 (all are rate-limited); NONE declares
 * 403 (nothing on the admin middleware stack emits it — the account-
 * freeze 403 is a USER-facing surface, not an admin one).
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

const SCOPE_ENUM = ['full', 'debits_only'] as const;
const REASON_CODE_ENUM = [
  'aml_review',
  'sanctions_screening',
  'suspected_fraud',
  'account_compromise',
  'law_enforcement_request',
  'chargeback_investigation',
  'other',
] as const;

export function registerAdminAccountHoldsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminWriteAudit: ReturnType<OpenAPIRegistry['register']>,
): void {
  const AccountHold = registry.register(
    'AccountHold',
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      scope: z.enum(SCOPE_ENUM).openapi({
        description:
          'Any live hold blocks BOTH money OUT (spend/redeem) AND money IN (outbound cashback/interest/emission payouts) — strict-AML: a flagged account receives nothing until cleared. The two tiers are retained for the audit record + future finer semantics; enforcement is currently uniform.',
      }),
      reasonCode: z.enum(REASON_CODE_ENUM),
      reason: z.string().openapi({ description: 'Operator rationale (2..500).' }),
      placedByUserId: z.string().uuid(),
      placedAt: z.string().datetime(),
      releasedAt: z.string().datetime().nullable(),
      releasedByUserId: z.string().uuid().nullable(),
      releaseReason: z.string().nullable(),
    }),
  );

  const AccountHoldsList = registry.register(
    'AccountHoldsList',
    z.object({ holds: z.array(AccountHold) }),
  );

  const PlaceHoldBody = registry.register(
    'PlaceAccountHoldBody',
    z.object({
      scope: z.enum(SCOPE_ENUM),
      reasonCode: z.enum(REASON_CODE_ENUM),
      reason: z.string().min(2).max(500),
    }),
  );

  const ReleaseHoldBody = registry.register(
    'ReleaseAccountHoldBody',
    z.object({ reason: z.string().min(2).max(500) }),
  );

  const AccountHoldEnvelope = registry.register(
    'AccountHoldEnvelope',
    z.object({ result: AccountHold, audit: adminWriteAudit }),
  );

  const stepUpHeaders = z.object({
    'idempotency-key': z.string().min(16).max(128).openapi({
      description: 'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
    }),
    'x-admin-step-up': z.string().openapi({
      description: 'ADR-028 step-up JWT minted by `POST /api/admin/step-up`. 5-minute TTL.',
    }),
  });

  registry.registerPath({
    method: 'post',
    path: '/api/admin/users/{userId}/holds',
    summary: 'Place a per-account freeze / AML-hold (NS-08).',
    description:
      'Freezes a single account. A live hold (either scope) refuses every user-initiated money-OUT path (order create, redeem, redeem-vault, legacy order create, credit-order spend) with 403 ACCOUNT_FROZEN AND pauses outbound payouts to the wallet (strict-AML: the account receives nothing until cleared). Admin-tier + ADR-028 step-up (`account-freeze` scope). ADR-017 compliant: `Idempotency-Key` header + `reason` (2..500) required. Re-freezing at the same scope is a no-op returning the live hold.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      headers: stepUpHeaders,
      body: { content: { 'application/json': { schema: PlaceHoldBody } } },
    },
    responses: {
      200: {
        description: 'Hold placed (or replayed from snapshot)',
        content: { 'application/json': { schema: AccountHoldEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid scope/reasonCode, or invalid reason',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer / missing or invalid step-up token',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Caller is not admin-tier staff (concealment), or target user not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error placing the hold, or an unreadable replay snapshot',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Step-up auth unavailable on this deployment (`STEP_UP_UNAVAILABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/admin/holds/{holdId}/release',
    summary: 'Release (unfreeze) a per-account hold (NS-08).',
    description:
      'Releases a live hold — re-opens the account. If it was the account’s last live hold, the debit paths resume and deferred payouts re-drain on the next payout tick. Admin-tier + ADR-028 step-up (`account-unfreeze` scope — separate from freeze so a freeze token can’t be replayed to unfreeze). ADR-017 compliant: `Idempotency-Key` header + `reason` (2..500) required.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ holdId: z.string().uuid() }),
      headers: stepUpHeaders,
      body: { content: { 'application/json': { schema: ReleaseHoldBody } } },
    },
    responses: {
      200: {
        description: 'Hold released (or replayed from snapshot)',
        content: { 'application/json': { schema: AccountHoldEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid holdId, or invalid reason',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer / missing or invalid step-up token',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Caller is not admin-tier staff (concealment), or hold not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description: 'Hold is already released (`HOLD_ALREADY_RELEASED`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error releasing the hold, or an unreadable replay snapshot',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Step-up auth unavailable on this deployment (`STEP_UP_UNAVAILABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/holds',
    summary: 'List a user’s account-hold history (NS-08).',
    description:
      'Returns every hold ever placed on the user (live + released), newest-first. Support-tier read.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ userId: z.string().uuid() }) },
    responses: {
      200: {
        description: 'The user’s hold history',
        content: { 'application/json': { schema: AccountHoldsList } },
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
        description: 'Caller is not staff (concealment)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading holds',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/holds',
    summary: 'List all live account holds (NS-08 dashboard).',
    description: 'Returns every LIVE hold across all users, newest-first. Support-tier read.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'All live holds',
        content: { 'application/json': { schema: AccountHoldsList } },
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
        description: 'Rate limit exceeded',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading holds',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
