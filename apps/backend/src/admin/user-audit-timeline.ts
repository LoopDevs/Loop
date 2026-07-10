/**
 * Per-subject admin audit timeline (ADR 037 §4 / A5-7).
 *
 * `GET /api/admin/users/:userId/audit` — merges FIVE existing,
 * already-bounded per-user reads into one newest-first, time-ordered
 * view so investigating "what happened to this user" doesn't mean
 * opening five separate admin pages. Every source is read-only and
 * reuses the exact query shape an existing per-user drill already
 * uses (no new money queries):
 *
 *   1. **Admin actions targeting this user** — `admin_idempotency_keys`
 *      (the ADR 017 write-audit store `./audit-tail.ts` already reads
 *      fleet-wide), filtered to paths that literally name this
 *      userId (`/api/admin/users/:userId/*` and
 *      `/api/admin/staff/:userId/role`). Covers credit-adjustments,
 *      refunds, emissions, home-currency changes, revoke-sessions,
 *      wallet reprovision, and staff-role grants/revokes targeting
 *      this user. **Limitation, inherited, not introduced here:**
 *      `admin_idempotency_keys` is a 24h-TTL idempotency cache
 *      (`./idempotency-store.ts`'s hourly sweep DELETEs rows past the
 *      TTL) — the exact same window the existing fleet-wide
 *      `GET /api/admin/audit-tail` is limited to. Admin actions older
 *      than 24h are gone from the DB, not just this endpoint. Because
 *      the table's total size is capped by admin write volume in the
 *      last 24h (not by user volume), a path-prefix filter with no
 *      dedicated `path` index stays cheap — this table cannot degrade
 *      into an S4-6-style scan-at-scale pathology the way
 *      `credit_transactions`/`orders` could without their composite
 *      indexes. A durable, subject-indexed admin audit log is a larger
 *      follow-up (readiness-backlog A5-7 note), not in scope here.
 *   2. **Money movements** — `credit_transactions`, the same
 *      `(user_id, created_at)`-indexed query shape as
 *      `./user-credit-transactions.ts`.
 *   3. **Orders** — `orders`, the same `(user_id, created_at)`-indexed
 *      shape as `./orders.ts`'s `adminListOrdersHandler`. An order's
 *      own timestamp columns (paid/procured/fulfilled/failed) already
 *      ARE its state history — surfaced in `detail` rather than
 *      expanded into one event per milestone, so one order stays one
 *      timeline row (keeps the event count predictable — see the
 *      CF-10 note below). The merged `at` for this row is `createdAt`,
 *      NOT the latest-populated milestone — money-review finding: `at`
 *      must be the same column the `before` cursor filters on (see
 *      below), or a row can re-appear on the next "older" page and
 *      stall pagination just below it.
 *   4. **Payouts** — `pending_payouts` via the existing
 *      `listPayoutsForAdmin({ userId })` (`../credits/pending-payouts.js`),
 *      riding `pending_payouts_user_created`. Same one-row-per-payout
 *      shape as orders.
 *   5. **Session revocations** — `refresh_tokens` rows for this user
 *      (`refresh_tokens_user` index, scoped to ONE user — bounded by
 *      that user's live+recent session count, further capped by
 *      `LOOP_AUTH_ROW_RETENTION_DAYS` purge), filtered to explicit
 *      revocations (`revoked_at IS NOT NULL AND replaced_by_jti IS
 *      NULL` — `revokeAllRefreshTokensForUser`, i.e. admin
 *      revoke-sessions or self sign-out-everywhere). A routine
 *      refresh-token ROTATION also sets `revoked_at` but WITH
 *      `replaced_by_jti` pointing at the superseding token — excluded
 *      here as churn noise, not a security-relevant event. An
 *      admin-triggered revoke also shows up under source (1) above
 *      (its path names the userId) — the two corroborate rather than
 *      duplicate misleadingly.
 *
 * Plus one current-STATE (not historical) snapshot:
 *
 *   6. **OTP lock** — a single PK lookup on `otp_attempt_counters`
 *      (keyed by email), surfaced as one synthetic event only when the
 *      account is presently locked. There is no append-only log of
 *      past OTP attempts to draw a history from (the counter is
 *      overwritten in place), so this is deliberately a snapshot, not
 *      a stream — documented limitation, not a gap this endpoint tries
 *      to paper over.
 *
 * **Bounded, never an unbounded scan (S4-6).** `?limit=` (default 8,
 * clamped [1, 20]) caps EACH of the five list sources independently;
 * the OTP-lock snapshot is always exactly 0 or 1 row. CF-10
 * (`./read-audit.ts`): the default response merges at most
 * `5 × 8 + 1 = 41` events — comfortably under `BULK_LIST_ROW_THRESHOLD`
 * (50) so a routine support-triage page load doesn't trip the
 * bulk-read tripwire; an explicit wide `?limit=` request legitimately
 * can (same posture as every other admin list endpoint).
 *
 * `?before=<iso>` is an approximate keyset cursor: for every source,
 * it's applied to the SAME column the merged `at` is built from
 * (`createdAt` for admin actions / ledger / orders / payouts,
 * `revokedAt` for sessions, `updatedAt` for the auth-lock snapshot) —
 * matching the cursor convention every other admin list endpoint in
 * this file tree uses, and required so a row can't re-appear on the
 * next "older" page (money-review finding — see the order/payout loop
 * comments below). Because up to five independently-cursored sources
 * are merged and re-sorted, paging older is a reasonable "everything
 * before roughly this point" walk for support triage — not a gapless
 * general-purpose paginator.
 *
 * Read-only: no mutation, no idempotency envelope, no PII beyond what
 * the underlying per-user drills already expose (no redeem codes/pins
 * — those stay encrypted on `orders` and are never selected here).
 * Support-tier (ADR 037 §3 lists "audit" among the shared read views).
 */
import type { Context } from 'hono';
import { and, desc, eq, isNotNull, isNull, like, lt, or } from 'drizzle-orm';
import type { AdminAuditTimelineEvent, AdminUserAuditTimelineResponse } from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import { db } from '../db/client.js';
import {
  adminIdempotencyKeys,
  creditTransactions,
  orders,
  otpAttemptCounters,
  refreshTokens,
  users,
} from '../db/schema.js';
import { listPayoutsForAdmin } from '../credits/pending-payouts.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-user-audit-timeline' });

const DEFAULT_PER_SOURCE_LIMIT = 8;
const MAX_PER_SOURCE_LIMIT = 20;

function iso(d: Date): string {
  return d.toISOString();
}

export async function adminUserAuditTimelineHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || !UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? String(DEFAULT_PER_SOURCE_LIMIT), 10);
  const limit = Math.min(
    Math.max(Number.isNaN(parsedLimit) ? DEFAULT_PER_SOURCE_LIMIT : parsedLimit, 1),
    MAX_PER_SOURCE_LIMIT,
  );

  const beforeRaw = c.req.query('before');
  let before: Date | undefined;
  if (beforeRaw !== undefined && beforeRaw.length > 0) {
    const d = new Date(beforeRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: 'before must be an ISO-8601 timestamp' },
        400,
      );
    }
    before = d;
  }

  try {
    const [subject] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (subject === undefined) {
      return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
    }

    // ─── 1. Admin actions targeting this user ─────────────────────────────
    const actionPathPrefix = `/api/admin/users/${userId}/`;
    const staffRolePath = `/api/admin/staff/${userId}/role`;
    const adminActionConditions = [
      or(
        like(adminIdempotencyKeys.path, `${actionPathPrefix}%`),
        eq(adminIdempotencyKeys.path, staffRolePath),
      ),
    ];
    if (before !== undefined)
      adminActionConditions.push(lt(adminIdempotencyKeys.createdAt, before));

    // ─── 2. Money movements ────────────────────────────────────────────────
    const ledgerConditions = [eq(creditTransactions.userId, userId)];
    if (before !== undefined) ledgerConditions.push(lt(creditTransactions.createdAt, before));

    // ─── 3. Orders ──────────────────────────────────────────────────────────
    const orderConditions = [eq(orders.userId, userId)];
    if (before !== undefined) orderConditions.push(lt(orders.createdAt, before));

    // ─── 5. Session revocations ─────────────────────────────────────────────
    const sessionConditions = [
      eq(refreshTokens.userId, userId),
      isNotNull(refreshTokens.revokedAt),
      isNull(refreshTokens.replacedByJti),
    ];
    if (before !== undefined) sessionConditions.push(lt(refreshTokens.revokedAt, before));

    const [adminActionRows, ledgerRows, orderRows, payoutRows, sessionRows, lockRows] =
      await Promise.all([
        db
          .select({
            actorEmail: users.email,
            method: adminIdempotencyKeys.method,
            path: adminIdempotencyKeys.path,
            status: adminIdempotencyKeys.status,
            createdAt: adminIdempotencyKeys.createdAt,
          })
          .from(adminIdempotencyKeys)
          .innerJoin(users, eq(adminIdempotencyKeys.adminUserId, users.id))
          .where(and(...adminActionConditions))
          .orderBy(desc(adminIdempotencyKeys.createdAt))
          .limit(limit),
        db
          .select()
          .from(creditTransactions)
          .where(and(...ledgerConditions))
          .orderBy(desc(creditTransactions.createdAt))
          .limit(limit),
        db
          .select({
            id: orders.id,
            state: orders.state,
            currency: orders.currency,
            chargeCurrency: orders.chargeCurrency,
            chargeMinor: orders.chargeMinor,
            merchantId: orders.merchantId,
            failureReason: orders.failureReason,
            createdAt: orders.createdAt,
            paidAt: orders.paidAt,
            procuredAt: orders.procuredAt,
            fulfilledAt: orders.fulfilledAt,
            failedAt: orders.failedAt,
          })
          .from(orders)
          .where(and(...orderConditions))
          .orderBy(desc(orders.createdAt))
          .limit(limit),
        listPayoutsForAdmin({ userId, limit, ...(before !== undefined ? { before } : {}) }),
        db
          .select({
            jti: refreshTokens.jti,
            createdAt: refreshTokens.createdAt,
            revokedAt: refreshTokens.revokedAt,
          })
          .from(refreshTokens)
          .where(and(...sessionConditions))
          .orderBy(desc(refreshTokens.revokedAt))
          .limit(limit),
        db
          .select({
            lockedUntil: otpAttemptCounters.lockedUntil,
            failedAttempts: otpAttemptCounters.failedAttempts,
            updatedAt: otpAttemptCounters.updatedAt,
          })
          .from(otpAttemptCounters)
          .where(eq(otpAttemptCounters.email, subject.email))
          .limit(1),
      ]);
    const lockRow = lockRows[0];

    const events: AdminAuditTimelineEvent[] = [];

    for (const r of adminActionRows) {
      events.push({
        kind: 'admin_action',
        at: iso(r.createdAt),
        summary: `${r.method} ${r.path} → ${r.status}`,
        refType: null,
        refId: null,
        detail: {
          actorEmail: r.actorEmail,
          method: r.method,
          path: r.path,
          status: r.status,
        },
      });
    }

    for (const r of ledgerRows) {
      const refType =
        r.referenceType === 'order' || r.referenceType === 'payout' ? r.referenceType : null;
      events.push({
        kind: 'ledger',
        at: iso(r.createdAt),
        summary: `${r.type} ${r.amountMinor.toString()} ${r.currency}`,
        refType,
        refId: refType !== null ? r.referenceId : null,
        detail: {
          transactionId: r.id,
          type: r.type,
          amountMinor: r.amountMinor.toString(),
          currency: r.currency,
          referenceType: r.referenceType,
          referenceId: r.referenceId,
        },
      });
    }

    for (const r of orderRows) {
      // `at` is `createdAt` — the SAME column the `before` cursor above
      // filters on (money-review finding: using the latest-populated
      // milestone here instead would desync the sort key from the
      // cursor's WHERE clause, so a row could re-appear on the next
      // "older" page and stall pagination just below it). The order's
      // full milestone history still rides in `detail` below.
      events.push({
        kind: 'order',
        at: iso(r.createdAt),
        summary: `Order ${r.id.slice(0, 8)}… — ${r.state}`,
        refType: 'order',
        refId: r.id,
        detail: {
          state: r.state,
          merchantId: r.merchantId,
          currency: r.currency,
          chargeCurrency: r.chargeCurrency,
          chargeMinor: r.chargeMinor.toString(),
          failureReason: r.failureReason,
          createdAt: iso(r.createdAt),
          paidAt: r.paidAt !== null ? iso(r.paidAt) : null,
          procuredAt: r.procuredAt !== null ? iso(r.procuredAt) : null,
          fulfilledAt: r.fulfilledAt !== null ? iso(r.fulfilledAt) : null,
          failedAt: r.failedAt !== null ? iso(r.failedAt) : null,
        },
      });
    }

    for (const r of payoutRows) {
      // Same reasoning as the order loop above: `at` is `createdAt` to
      // stay consistent with `listPayoutsForAdmin`'s own `before`
      // cursor (also `createdAt`-based) — not the latest milestone.
      events.push({
        kind: 'payout',
        at: iso(r.createdAt),
        summary: `Payout ${r.id.slice(0, 8)}… — ${r.state} (${r.kind})`,
        refType: 'payout',
        refId: r.id,
        detail: {
          state: r.state,
          kind: r.kind,
          assetCode: r.assetCode,
          amountStroops: r.amountStroops.toString(),
          orderId: r.orderId,
          txHash: r.txHash,
          lastError: r.lastError,
          createdAt: iso(r.createdAt),
          submittedAt: r.submittedAt !== null ? iso(r.submittedAt) : null,
          confirmedAt: r.confirmedAt !== null ? iso(r.confirmedAt) : null,
          failedAt: r.failedAt !== null ? iso(r.failedAt) : null,
        },
      });
    }

    for (const r of sessionRows) {
      // Guarded by `isNotNull(revokedAt)` in the query — non-null here.
      const revokedAt = r.revokedAt as Date;
      events.push({
        kind: 'session_revoked',
        at: iso(revokedAt),
        summary: 'Session revoked',
        refType: null,
        refId: null,
        detail: {
          jti: r.jti,
          createdAt: iso(r.createdAt),
          revokedAt: iso(revokedAt),
        },
      });
    }

    if (
      lockRow !== undefined &&
      lockRow.lockedUntil !== null &&
      lockRow.lockedUntil.getTime() > Date.now() &&
      (before === undefined || lockRow.updatedAt.getTime() < before.getTime())
    ) {
      events.push({
        kind: 'auth_lock',
        at: iso(lockRow.updatedAt),
        summary: `OTP verification locked until ${iso(lockRow.lockedUntil)}`,
        refType: null,
        refId: null,
        detail: {
          lockedUntil: iso(lockRow.lockedUntil),
          failedAttempts: lockRow.failedAttempts,
        },
      });
    }

    events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

    return c.json<AdminUserAuditTimelineResponse>({ userId, events });
  } catch (err) {
    log.error({ err, userId }, 'Admin user audit-timeline lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load audit timeline' }, 500);
  }
}
