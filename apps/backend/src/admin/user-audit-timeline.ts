/**
 * Per-subject admin audit timeline (ADR 037 §4 / A5-7).
 *
 * `GET /api/admin/users/:userId/audit` — merges FIVE existing,
 * already-bounded per-user reads into one newest-first, time-ordered
 * PAGE so investigating "what happened to this user" doesn't mean
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
 *      timeline row. The merged `at` is `createdAt`, NOT the latest
 *      milestone — money-review finding: `at` must be the same column
 *      the cursor pages on, or a row can re-appear on the next page
 *      and stall pagination.
 *   4. **Payouts** — `pending_payouts` via the existing
 *      `listPayoutsForAdmin({ userId })` (`../credits/pending-payouts.js`),
 *      riding `pending_payouts_user_created`. Same one-row-per-payout
 *      shape as orders; `at` = `createdAt`.
 *   5. **Session revocations** — `refresh_tokens` rows for this user
 *      (`refresh_tokens_user` index, scoped to ONE user — bounded by
 *      that user's live+recent session count, further capped by
 *      `LOOP_AUTH_ROW_RETENTION_DAYS` purge), filtered to explicit
 *      revocations (`revoked_at IS NOT NULL AND replaced_by_jti IS
 *      NULL` — `revokeAllRefreshTokensForUser`, i.e. admin
 *      revoke-sessions or self sign-out-everywhere). A routine
 *      refresh-token ROTATION also sets `revoked_at` but WITH
 *      `replaced_by_jti` pointing at the superseding token — excluded
 *      here as churn noise, not a security-relevant event. `at` =
 *      `revokedAt`.
 *
 * Plus one current-STATE (not historical) snapshot:
 *
 *   6. **OTP lock** — a single PK lookup on `otp_attempt_counters`
 *      (keyed by email), surfaced as one synthetic event only when the
 *      account is presently locked. There is no append-only log of
 *      past OTP attempts to draw a history from (the counter is
 *      overwritten in place), so this is deliberately a snapshot, not
 *      a stream. It is NOT a paged source: it appears once, on page 1
 *      only (no `before*` cursors present), and carries no cursor.
 *
 * **Per-source keyset pagination (not one shared cursor).** Each of
 * the five list sources is independently `.limit()`-bounded AND
 * independently cursored: the response's `nextCursors` carries one
 * `<iso|null>` per source (the oldest `at` that source returned this
 * page, or null when it returned fewer than `limit` rows / wasn't
 * queried). The client echoes those back as `?before<Source>=<iso>`
 * query params; each source pages on ITS OWN cursor. This is the fix
 * for the cross-source row-loss bug a single shared `before` would
 * cause: with uneven per-source density (many ledger rows per order),
 * a global cursor = the oldest `at` across the merged page would
 * permanently drop the denser source's un-returned rows (newer than
 * the global floor, so they never satisfy `< floor` on the next
 * page). A support/compliance "what happened to this user" tool must
 * be complete, so completeness is enforced, not documented away.
 *
 * **Page mode.** A request with NO `before*` params is page 1: every
 * source is queried and the OTP-lock snapshot is computed. A request
 * with ANY `before*` param is a later page: ONLY the sources whose
 * cursor is present are re-queried (a null/absent cursor means that
 * source is exhausted), and the OTP-lock snapshot is omitted.
 *
 * **Bounded, never an unbounded scan (S4-6).** `?limit=` (default 8,
 * clamped [1, 20]) caps EACH list source; the OTP-lock snapshot is
 * always exactly 0 or 1 row. CF-10 (`./read-audit.ts`): a page merges
 * at most `5 × 8 + 1 = 41` events — comfortably under
 * `BULK_LIST_ROW_THRESHOLD` (50) so a routine support-triage page
 * load doesn't trip the bulk-read tripwire; an explicit wide `?limit=`
 * request legitimately can (same posture as every other admin list
 * endpoint).
 *
 * Read-only: no mutation, no idempotency envelope, no PII beyond what
 * the underlying per-user drills already expose (no redeem codes/pins
 * — those stay encrypted on `orders` and are never selected here).
 * Support-tier (ADR 037 §3 lists "audit" among the shared read views).
 */
import type { Context } from 'hono';
import { and, desc, eq, isNotNull, isNull, like, lt, or } from 'drizzle-orm';
import type {
  AdminAuditTimelineCursors,
  AdminAuditTimelineEvent,
  AdminUserAuditTimelineResponse,
} from '@loop/shared';
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

/** The five paged sources, and the query param each cursor maps to. */
const SOURCE_CURSOR_PARAM = {
  adminActions: 'beforeAdminActions',
  ledger: 'beforeLedger',
  orders: 'beforeOrders',
  payouts: 'beforePayouts',
  sessions: 'beforeSessions',
} as const;
type SourceKey = keyof typeof SOURCE_CURSOR_PARAM;
const SOURCE_KEYS = Object.keys(SOURCE_CURSOR_PARAM) as SourceKey[];

function iso(d: Date): string {
  return d.toISOString();
}

/**
 * Next-cursor for one source: null when it wasn't queried, or returned
 * fewer than `limit` rows (exhausted). Otherwise the `at` of the
 * oldest event it returned this page (events are newest-first, so the
 * last one is the oldest).
 */
function nextCursorFor(
  queried: boolean,
  events: AdminAuditTimelineEvent[],
  limit: number,
): string | null {
  if (!queried || events.length < limit) return null;
  return events[events.length - 1]?.at ?? null;
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

  // Parse + validate each source's `before` cursor independently.
  const before: Partial<Record<SourceKey, Date>> = {};
  const present: Record<SourceKey, boolean> = {
    adminActions: false,
    ledger: false,
    orders: false,
    payouts: false,
    sessions: false,
  };
  for (const key of SOURCE_KEYS) {
    const raw = c.req.query(SOURCE_CURSOR_PARAM[key]);
    if (raw === undefined || raw.length === 0) continue;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      return c.json(
        {
          code: 'VALIDATION_ERROR',
          message: `${SOURCE_CURSOR_PARAM[key]} must be an ISO-8601 timestamp`,
        },
        400,
      );
    }
    before[key] = d;
    present[key] = true;
  }

  // Page 1 = no cursors at all → query every source + the OTP-lock
  // snapshot. Any cursor present = a later page → only re-query the
  // sources that still have a cursor; omit the snapshot.
  const isFirstPage = !SOURCE_KEYS.some((k) => present[k]);
  const shouldQuery = (key: SourceKey): boolean => isFirstPage || present[key];

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
    const adminActionsPromise = shouldQuery('adminActions')
      ? (async () => {
          const actionPathPrefix = `/api/admin/users/${userId}/`;
          const staffRolePath = `/api/admin/staff/${userId}/role`;
          const conds = [
            or(
              like(adminIdempotencyKeys.path, `${actionPathPrefix}%`),
              eq(adminIdempotencyKeys.path, staffRolePath),
            ),
          ];
          const cursor = before.adminActions;
          if (cursor !== undefined) conds.push(lt(adminIdempotencyKeys.createdAt, cursor));
          return db
            .select({
              actorEmail: users.email,
              method: adminIdempotencyKeys.method,
              path: adminIdempotencyKeys.path,
              status: adminIdempotencyKeys.status,
              createdAt: adminIdempotencyKeys.createdAt,
            })
            .from(adminIdempotencyKeys)
            .innerJoin(users, eq(adminIdempotencyKeys.adminUserId, users.id))
            .where(and(...conds))
            .orderBy(desc(adminIdempotencyKeys.createdAt))
            .limit(limit);
        })()
      : Promise.resolve([] as never[]);

    // ─── 2. Money movements ────────────────────────────────────────────────
    const ledgerPromise = shouldQuery('ledger')
      ? (async () => {
          const conds = [eq(creditTransactions.userId, userId)];
          const cursor = before.ledger;
          if (cursor !== undefined) conds.push(lt(creditTransactions.createdAt, cursor));
          return db
            .select()
            .from(creditTransactions)
            .where(and(...conds))
            .orderBy(desc(creditTransactions.createdAt))
            .limit(limit);
        })()
      : Promise.resolve([] as never[]);

    // ─── 3. Orders ──────────────────────────────────────────────────────────
    const ordersPromise = shouldQuery('orders')
      ? (async () => {
          const conds = [eq(orders.userId, userId)];
          const cursor = before.orders;
          if (cursor !== undefined) conds.push(lt(orders.createdAt, cursor));
          return db
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
            .where(and(...conds))
            .orderBy(desc(orders.createdAt))
            .limit(limit);
        })()
      : Promise.resolve([] as never[]);

    // ─── 4. Payouts ───────────────────────────────────────────────────────
    const payoutsPromise = shouldQuery('payouts')
      ? listPayoutsForAdmin({
          userId,
          limit,
          ...(before.payouts !== undefined ? { before: before.payouts } : {}),
        })
      : Promise.resolve([] as never[]);

    // ─── 5. Session revocations ─────────────────────────────────────────────
    const sessionsPromise = shouldQuery('sessions')
      ? (async () => {
          const conds = [
            eq(refreshTokens.userId, userId),
            isNotNull(refreshTokens.revokedAt),
            isNull(refreshTokens.replacedByJti),
          ];
          const cursor = before.sessions;
          if (cursor !== undefined) conds.push(lt(refreshTokens.revokedAt, cursor));
          return db
            .select({
              jti: refreshTokens.jti,
              createdAt: refreshTokens.createdAt,
              revokedAt: refreshTokens.revokedAt,
            })
            .from(refreshTokens)
            .where(and(...conds))
            .orderBy(desc(refreshTokens.revokedAt))
            .limit(limit);
        })()
      : Promise.resolve([] as never[]);

    // ─── 6. OTP-lock snapshot (page 1 only, single row) ──────────────────────
    const lockPromise = isFirstPage
      ? db
          .select({
            lockedUntil: otpAttemptCounters.lockedUntil,
            failedAttempts: otpAttemptCounters.failedAttempts,
            updatedAt: otpAttemptCounters.updatedAt,
          })
          .from(otpAttemptCounters)
          .where(eq(otpAttemptCounters.email, subject.email))
          .limit(1)
      : Promise.resolve([] as never[]);

    const [adminActionRows, ledgerRows, orderRows, payoutRows, sessionRows, lockRows] =
      await Promise.all([
        adminActionsPromise,
        ledgerPromise,
        ordersPromise,
        payoutsPromise,
        sessionsPromise,
        lockPromise,
      ]);

    // Build per-source event lists so each source's next-cursor is the
    // oldest `at` IT returned (never a cross-source min).
    const adminEvents: AdminAuditTimelineEvent[] = adminActionRows.map((r) => ({
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
    }));

    const ledgerEvents: AdminAuditTimelineEvent[] = ledgerRows.map((r) => {
      const refType =
        r.referenceType === 'order' || r.referenceType === 'payout' ? r.referenceType : null;
      return {
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
      };
    });

    const orderEvents: AdminAuditTimelineEvent[] = orderRows.map((r) => ({
      kind: 'order',
      // `at` is `createdAt` — the SAME column the cursor pages on (see
      // the handler doc). The full milestone history rides in `detail`.
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
    }));

    const payoutEvents: AdminAuditTimelineEvent[] = payoutRows.map((r) => ({
      kind: 'payout',
      // Same reasoning as orders: `at` = `createdAt`, matching
      // `listPayoutsForAdmin`'s own `before` cursor column.
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
    }));

    const sessionEvents: AdminAuditTimelineEvent[] = sessionRows.map((r) => {
      // Guarded by `isNotNull(revokedAt)` in the query — non-null here.
      const revokedAt = r.revokedAt as Date;
      return {
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
      };
    });

    const events: AdminAuditTimelineEvent[] = [
      ...adminEvents,
      ...ledgerEvents,
      ...orderEvents,
      ...payoutEvents,
      ...sessionEvents,
    ];

    const lockRow = lockRows[0];
    if (
      lockRow !== undefined &&
      lockRow.lockedUntil !== null &&
      lockRow.lockedUntil.getTime() > Date.now()
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

    const nextCursors: AdminAuditTimelineCursors = {
      adminActions: nextCursorFor(shouldQuery('adminActions'), adminEvents, limit),
      ledger: nextCursorFor(shouldQuery('ledger'), ledgerEvents, limit),
      orders: nextCursorFor(shouldQuery('orders'), orderEvents, limit),
      payouts: nextCursorFor(shouldQuery('payouts'), payoutEvents, limit),
      sessions: nextCursorFor(shouldQuery('sessions'), sessionEvents, limit),
    };

    return c.json<AdminUserAuditTimelineResponse>({ userId, events, nextCursors });
  } catch (err) {
    log.error({ err, userId }, 'Admin user audit-timeline lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load audit timeline' }, 500);
  }
}
