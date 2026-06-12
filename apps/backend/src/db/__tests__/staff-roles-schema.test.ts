/**
 * ADR 037 / migration 0042: the `staff_roles` table mirror plus the
 * two reverse-lookup indexes. Pins the Drizzle mirror of the
 * hand-written SQL — check-migration-parity catches catalog drift;
 * these pin the TS-facing narrowing the catalog can't see.
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { orders, staffRoles, users } from '../schema.js';

type StaffRoleRow = typeof staffRoles.$inferSelect;
type StaffRoleInsert = typeof staffRoles.$inferInsert;

describe('staff_roles table (ADR 037 / migration 0042)', () => {
  it('role is NOT NULL and narrowed to the admin|support union', () => {
    expectTypeOf<StaffRoleRow['role']>().toEqualTypeOf<'admin' | 'support'>();
    expect(staffRoles.role.notNull).toBe(true);
    expect(staffRoles.role.hasDefault).toBe(false);
  });

  it('user_id is the primary key', () => {
    expect(staffRoles.userId.primary).toBe(true);
  });

  it('granted_at is NOT NULL with a default; grantor + reason are nullable', () => {
    expect(staffRoles.grantedAt.notNull).toBe(true);
    expect(staffRoles.grantedAt.hasDefault).toBe(true);
    expect(staffRoles.grantedByUserId.notNull).toBe(false);
    expect(staffRoles.reason.notNull).toBe(false);
    expectTypeOf<StaffRoleRow['grantedByUserId']>().toEqualTypeOf<string | null>();
    expectTypeOf<StaffRoleRow['reason']>().toEqualTypeOf<string | null>();
  });

  it('declares the role CHECK mirror', () => {
    const checkNames = getTableConfig(staffRoles).checks.map((c) => c.name);
    expect(checkNames).toContain('staff_roles_role_known');
  });

  it('declares both FKs to users', () => {
    const fks = getTableConfig(staffRoles).foreignKeys;
    expect(fks).toHaveLength(2);
  });

  it('inserts require userId + role only (seed/grant shape)', () => {
    const insert: StaffRoleInsert = {
      userId: '11111111-1111-1111-1111-111111111111',
      role: 'support',
    };
    expectTypeOf(insert).toMatchTypeOf<StaffRoleInsert>();
  });
});

describe('ADR 037 reverse-lookup indexes (migration 0042)', () => {
  it('orders declares the partial payment-memo index', () => {
    const idx = getTableConfig(orders).indexes.find((i) => i.config.name === 'orders_payment_memo');
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(false);
    expect(idx?.config.where).toBeDefined();
  });

  it('users declares the partial stellar-address index', () => {
    const idx = getTableConfig(users).indexes.find(
      (i) => i.config.name === 'users_stellar_address',
    );
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(false);
    expect(idx?.config.where).toBeDefined();
  });
});
