/**
 * Drizzle schema — merchants domain (hardening D2 split).
 * Re-exported through `../schema.ts` (the barrel), so every existing
 * `import { ... } from '../db/schema.js'` call site is unchanged.
 */
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  numeric,
  integer,
  index,
  check,
  jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Per-merchant user-cashback share (ADR 011, reshaped by ADR 052).
 * Single knob: the share of Loop's CTX margin handed to the
 * customer. 0 = Loop keeps the whole spread, 100 = all of it goes
 * to the customer. Delivered as CTX's native user discount at
 * checkout — on admin save (and on the hourly catalog-sweep
 * reconcile) Loop pushes `userDiscountBasisPoints =
 * floor(operatorDiscountBp × pct / 100)` to CTX via
 * `PUT /merchant-links`, so the customer simply pays less.
 * Per-order minor amounts are pinned onto the order row from CTX's
 * card snapshot, so a later admin edit doesn't retroactively
 * rewrite completed orders.
 */
export const merchantCashbackConfigs = pgTable(
  'merchant_cashback_configs',
  {
    merchantId: text('merchant_id').primaryKey(),
    userCashbackPct: numeric('user_cashback_pct', { precision: 5, scale: 2 }).notNull(),
    active: boolean('active').notNull().default(true),
    updatedBy: text('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'merchant_cashback_configs_pct_range',
      sql`${t.userCashbackPct} >= 0 AND ${t.userCashbackPct} <= 100`,
    ),
  ],
);

/**
 * Audit log for `merchant_cashback_configs`. Written by a trigger
 * installed in the first migration; every update appends the prior
 * values with the changing admin's identity + timestamp, giving us
 * a full history without a version-control-like UX.
 *
 * No FK to `merchantCashbackConfigs` — we want history rows to
 * survive if a config row is ever deleted (which shouldn't happen
 * in normal ops, but the history should outlive it).
 *
 * A2-703: drizzle-kit does NOT model triggers, functions, or
 * policies. The trigger + plpgsql function that write to this table
 * live in the SQL migrations only (0000 creates, 0016 re-asserts
 * idempotently). Running `drizzle-kit generate` after schema
 * changes will NOT emit them — you must manually verify migrations
 * preserve the `record_merchant_cashback_config_history` function
 * and the `merchant_cashback_configs_audit` BEFORE UPDATE trigger.
 * Migration 0016 re-asserts both via CREATE OR REPLACE + DROP IF
 * EXISTS + CREATE so any accidental drizzle-push that dropped them
 * gets healed on next deploy.
 */
export const merchantCashbackConfigHistory = pgTable(
  'merchant_cashback_config_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: text('merchant_id').notNull(),
    userCashbackPct: numeric('user_cashback_pct', { precision: 5, scale: 2 }).notNull(),
    active: boolean('active').notNull(),
    changedBy: text('changed_by').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('merchant_cashback_config_history_merchant').on(t.merchantId, t.changedAt)],
);

/**
 * Last-good CTX catalog snapshots (R3-3).
 *
 * Public catalog surfaces are served from in-memory stores for speed,
 * but booting during a CTX outage must not start those stores empty.
 * Each successful full upstream sweep replaces the matching snapshot;
 * startup hydrates from it before trying CTX. `name` is deliberately
 * a tiny discriminator instead of separate tables so merchants and
 * locations share one recovery path.
 */
export const ctxCatalogSnapshots = pgTable(
  'ctx_catalog_snapshots',
  {
    name: text('name').primaryKey().$type<'merchants' | 'locations'>(),
    payload: jsonb('payload').notNull(),
    itemCount: integer('item_count').notNull(),
    loadedAt: timestamp('loaded_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ctx_catalog_snapshots_name_known', sql`${t.name} IN ('merchants', 'locations')`),
    check('ctx_catalog_snapshots_payload_array', sql`jsonb_typeof(${t.payload}) = 'array'`),
    check('ctx_catalog_snapshots_item_count_non_negative', sql`${t.itemCount} >= 0`),
  ],
);
