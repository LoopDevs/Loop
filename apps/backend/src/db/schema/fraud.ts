/**
 * Drizzle schema — fraud/abuse domain (ADR 045, B-3).
 * Re-exported through `../schema.ts` (the barrel), so every existing
 * `import { ... } from '../db/schema.js'` call site is unchanged.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  check,
  uniqueIndex,
  jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

/**
 * Signal types this table can hold. Deliberately a closed, narrow
 * union — ADR 045 Phase 1 implements exactly one detector
 * (`shared_funding_source`); the CHECK constraint below is the DB-side
 * twin so a hand-written INSERT can't introduce an unrecognised type
 * silently.
 */
export const FRAUD_SIGNAL_TYPES = ['shared_funding_source'] as const;
export type FraudSignalType = (typeof FRAUD_SIGNAL_TYPES)[number];

/**
 * ADR 045 §2 — duplicate-account detection storage. Flag-only, never
 * auto-block: a row here is a signal for ops review (queryable
 * directly + a Discord page on first occurrence via
 * `notifyDuplicateAccountSignal`), not an action taken against either
 * user's account.
 *
 * One row per (signal_type, user_id, related_user_id) pair — the
 * unique index means a pair that repeatedly re-triggers the same
 * detector (e.g. the same two accounts funding from the same wallet
 * every week) writes exactly once, and lets the write path use
 * `ON CONFLICT DO NOTHING` to tell "fresh signal" (page Discord) from
 * "already known" (stay quiet) without a separate read.
 *
 * `related_user_id` is nullable for future pairwise-optional signal
 * types (e.g. a rapid-signup-from-one-IP detector would have no
 * natural "other user" — it's a count against an IP, not a pair).
 * Postgres unique indexes treat NULL as distinct-from-every-other-NULL,
 * so a NULL `related_user_id` never collides with another NULL row —
 * uniqueness for such signal types would need a different shape
 * (a separate table or a NULLS NOT DISTINCT index) when one is added;
 * not needed for the single detector implemented here, which always
 * sets `related_user_id`.
 */
export const fraudSignals = pgTable(
  'fraud_signals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    signalType: text('signal_type').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    relatedUserId: uuid('related_user_id').references(() => users.id, { onDelete: 'restrict' }),
    /**
     * Detector-specific evidence, e.g. for `shared_funding_source`:
     * `{ sourceAccount, orderId, relatedOrderId }`. Not schema-typed
     * further — ops reads this via direct DB query in Phase 1 (ADR
     * 044 deliberately defers an admin list endpoint).
     */
    detail: jsonb('detail').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('fraud_signals_user_created').on(t.userId, t.createdAt),
    index('fraud_signals_related_user')
      .on(t.relatedUserId)
      .where(sql`${t.relatedUserId} IS NOT NULL`),
    uniqueIndex('fraud_signals_type_user_related_unique').on(
      t.signalType,
      t.userId,
      t.relatedUserId,
    ),
    check('fraud_signals_type_known', sql`${t.signalType} IN ('shared_funding_source')`),
  ],
);
