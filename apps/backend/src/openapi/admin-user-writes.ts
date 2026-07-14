/**
 * Admin user-property write OpenAPI registrations: home-currency
 * change (ADR 015 deferred), session revocation (B4), the B5
 * OTP-lockout clear (A5-3), and the sibling deposit-refund (A6).
 *
 * Sibling of `./admin-credit-writes.ts` — that file's docstring
 * stays honest as "credits / refunds / withdrawals", not a catch-all
 * for every admin-mediated user write; this one holds the rest.
 *
 * Three locally-scoped schemas travel with the slice:
 *   - HomeCurrencySetBody / Result / Envelope
 *
 * `AdminWriteAudit` is threaded in as a parameter so the slice
 * shares the same registered schema instance with the rest of the
 * admin-write surface.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

export function registerAdminUserWritesOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminWriteAudit: ReturnType<OpenAPIRegistry['register']>,
): void {
  const AdminWriteAudit = adminWriteAudit;

  const HomeCurrencySetBody = registry.register(
    'HomeCurrencySetBody',
    z.object({
      homeCurrency: z.enum(['USD', 'GBP', 'EUR']).openapi({
        description:
          "Target user's new home currency. Must differ from the current value; the handler rejects no-op writes.",
      }),
      reason: z.string().min(2).max(500),
    }),
  );

  const HomeCurrencySetResult = registry.register(
    'HomeCurrencySetResult',
    z.object({
      userId: z.string().uuid(),
      priorHomeCurrency: z.string().length(3),
      newHomeCurrency: z.string().length(3),
      updatedAt: z.string().datetime(),
    }),
  );

  const HomeCurrencySetEnvelope = registry.register(
    'HomeCurrencySetEnvelope',
    z.object({
      result: HomeCurrencySetResult,
      audit: AdminWriteAudit,
    }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/admin/users/{userId}/home-currency',
    summary: "Change a user's home currency (ADR 015 deferred § support-mediated change).",
    description:
      "Flips `users.home_currency` after preflight invariants confirm the switch is safe. Refuses with 409 if the user has a non-zero credit balance in the OLD currency (`HOME_CURRENCY_HAS_LIVE_BALANCE`) or any in-flight payouts in `pending` / `submitted` state (`HOME_CURRENCY_HAS_IN_FLIGHT_PAYOUTS`); both would be silently orphaned by the switch. ADR-017 admin-write contract: actor from `requireAdmin`, `Idempotency-Key` header required, `reason` body field (2..500 chars), Discord audit fanout AFTER commit. ADR-028 step-up gate is enforced at the route — a captured bearer alone cannot retarget a user's future cashback asset.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
        'x-admin-step-up': z.string().openapi({
          description: 'ADR-028 step-up JWT minted by `POST /api/admin/step-up`. 5-minute TTL.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: HomeCurrencySetBody } },
      },
    },
    responses: {
      200: {
        description: 'Home currency changed (or replayed from idempotency snapshot)',
        content: { 'application/json': { schema: HomeCurrencySetEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid body, or non-uuid userId',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer / missing or invalid step-up token',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Target user does not exist (`USER_NOT_FOUND`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description:
          'No-op (`HOME_CURRENCY_UNCHANGED`), live balance in old currency (`HOME_CURRENCY_HAS_LIVE_BALANCE`), in-flight payouts (`HOME_CURRENCY_HAS_IN_FLIGHT_PAYOUTS`), or concurrent change (`CONCURRENT_CHANGE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Internal error applying the change (`INTERNAL_ERROR`), or the stored replay snapshot for this Idempotency-Key is unreadable (`IDEMPOTENCY_SNAPSHOT_CORRUPT` — the write is never re-executed)',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Step-up auth unavailable on this deployment (`STEP_UP_UNAVAILABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // B4: admin session revocation (incident response). Admin-tier, NOT
  // step-up-gated (reversible, no value movement).
  const AdminRevokeSessionsResult = registry.register(
    'AdminRevokeSessionsResult',
    z.object({
      userId: z.string().uuid(),
      message: z.string(),
    }),
  );

  // A6: late-deposit refund-to-sender.
  const DepositRefundBody = registry.register(
    'DepositRefundBody',
    z.object({
      reason: z.string().min(2).max(500).openapi({
        description: 'Why the deposit is being refunded — lands in the audit trail.',
      }),
    }),
  );

  const DepositRefundResult = registry.register(
    'DepositRefundResult',
    z.object({
      paymentId: z.string(),
      status: z.enum(['refunded', 'already_refunded']),
      txHash: z.string(),
    }),
  );

  const DepositRefundEnvelope = registry.register(
    'DepositRefundEnvelope',
    z.object({ result: DepositRefundResult, audit: AdminWriteAudit }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/admin/deposits/{paymentId}/refund',
    summary: 'Refund an abandoned late deposit to its sender (hardening A6).',
    description:
      "Submits an outbound Stellar payment from the operator account returning an abandoned late deposit (one that landed just after its order expired) to its on-chain sender. Idempotent + crash-safe (CF-18 hash persisted before submit); a replay returns `already_refunded`. Admin-tier + step-up (`'deposit-refund'` scope). ADR-017 admin-write contract: `Idempotency-Key` header + `reason` body (2..500 chars) required; a repeat call returns the stored snapshot with `audit.replayed: true`. The same `refundDeposit()` path runs automatically when `LOOP_DEPOSIT_REFUND_AUTO=true`.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ paymentId: z.string() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
        'x-admin-step-up': z.string().openapi({
          description: 'ADR-028 step-up JWT scoped to `deposit-refund`. 5-minute TTL.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: DepositRefundBody } },
      },
    },
    responses: {
      200: {
        description: 'Refunded (or replayed from idempotency snapshot as `already_refunded`)',
        content: { 'application/json': { schema: DepositRefundEnvelope } },
      },
      400: {
        description:
          'Missing idempotency key, invalid reason, or missing/invalid paymentId (`VALIDATION_ERROR`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer / step-up token',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description:
          'No skipped deposit with that id (`NOT_FOUND`). Also returned to non-admin callers (requireStaff masks the admin surface).',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description:
          'A refund is already in progress (`PAYMENT_IN_FLIGHT`) or the deposit is not refundable — not abandoned, unparseable, or missing sender/amount (`DEPOSIT_NOT_REFUNDABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      502: {
        description:
          'Stellar submit failed (`REFUND_SUBMIT_FAILED`) — the claim is released for retry',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Step-up auth unavailable on this deployment (`STEP_UP_UNAVAILABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/admin/users/{userId}/revoke-sessions',
    summary: "Revoke all of a user's live sessions (hardening B4 — incident response).",
    description:
      'Revokes every live refresh token for the target user — the incident-response lever for a compromised account. Access tokens are non-revocable by design (15-min TTL), so the session dies within at most that window. Admin-tier; NOT step-up-gated (reversible — the user just signs back in — and moves no value, so step-up friction during a fast security response is counterproductive).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'All sessions revoked',
        content: { 'application/json': { schema: AdminRevokeSessionsResult } },
      },
      400: {
        description: 'Non-uuid userId (`VALIDATION_ERROR`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description:
          'Target user not found (`NOT_FOUND`). Also returned to non-admin callers: requireStaff masks the admin surface as 404.',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error revoking sessions (`INTERNAL_ERROR`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // A5-3: clear the B5 verify-otp lockout counter for a user (incident
  // response — "user is locked out and can't get in"). Admin-tier, NOT
  // step-up-gated; DOES carry a required `reason` + Discord audit
  // (ADR 017-lite), unlike the plainer revoke-sessions above. See
  // `admin/clear-otp-lockout.ts` for the tier/step-up reasoning.
  const ClearOtpLockoutBody = registry.register(
    'ClearOtpLockoutBody',
    z.object({
      reason: z.string().min(2).max(500).openapi({
        description: 'Why the lockout is being cleared — lands in the Discord audit trail.',
      }),
    }),
  );
  const ClearOtpLockoutResult = registry.register(
    'AdminClearOtpLockoutResult',
    z.object({
      userId: z.string().uuid(),
      wasLocked: z.boolean().openapi({
        description: 'Whether the account was actually locked before this call.',
      }),
      cleared: z.literal(true),
    }),
  );
  const ClearOtpLockoutEnvelope = registry.register(
    'AdminClearOtpLockoutEnvelope',
    z.object({ result: ClearOtpLockoutResult, audit: AdminWriteAudit }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/admin/users/{userId}/clear-otp-lockout',
    summary: 'Clear a user’s B5 verify-otp lockout (readiness-backlog A5-3).',
    description:
      "Deletes the user's `otp_attempt_counters` row via the same `clearOtpAttempts` primitive a successful `verify-otp` uses — no bespoke unlock path. Idempotent: clearing an already-clear (or never-locked) counter is a no-op success (`wasLocked: false`). Admin-tier; NOT step-up-gated — like `revoke-sessions`, this moves no value and clearing the counter alone doesn't grant access, it only lets the user retry (any further wrong guess re-arms the same B5 lockout). Requires a `reason` (2..500 chars) and fires the Discord admin-audit fanout after commit, unlike `revoke-sessions` which predates that convention. Bounded by a PER-TARGET velocity cap (5 clears / 24h / account, `OTP_LOCKOUT_CLEAR_RATE_EXCEEDED` → 429) — this, not the per-IP route limit, is what stops a compromised admin bearer using the clear→guess→clear loop to erode B5's ceiling on one account; the count fails closed (503) if it can't be evaluated.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: ClearOtpLockoutBody } },
      },
    },
    responses: {
      200: {
        description: 'Lockout cleared (or replayed from idempotency snapshot)',
        content: { 'application/json': { schema: ClearOtpLockoutEnvelope } },
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
        description:
          'Target user not found (`USER_NOT_FOUND`). Also returned to non-admin callers: requireStaff masks the admin surface as 404.',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description:
          'Fail-closed: another clear for this SAME account is in progress and holds the per-target advisory lock, so no clear was performed (`OTP_LOCKOUT_CLEAR_CONCURRENT`) — this serialises distinct-idempotency-key bursts at one target so they can’t slip extra clears past the per-target velocity cap; retry.',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description:
          'Per-IP rate limit (20/min), OR the per-target velocity cap: this account has already had its OTP lockout cleared `CLEAR_LOCKOUT_MAX_PER_TARGET_PER_DAY` (5) times in the last 24h (`OTP_LOCKOUT_CLEAR_RATE_EXCEEDED`) — the control that bounds the clear→guess→clear loop against a single account.',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Internal error (`INTERNAL_ERROR`), or unreadable replay snapshot (`IDEMPOTENCY_SNAPSHOT_CORRUPT`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description:
          'Fail-closed: the per-target clear-rate check query failed, so no clear was performed (`OTP_LOCKOUT_CLEAR_RATE_CHECK_UNAVAILABLE`) — retry.',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
