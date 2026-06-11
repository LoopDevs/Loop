import { describe, it, expect, expectTypeOf } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { users } from '../schema.js';

type UserRow = typeof users.$inferSelect;
type UserInsert = typeof users.$inferInsert;

/**
 * ADR 030 Phase B / migration 0035: `users.wallet_provider` +
 * `users.wallet_id` link a Loop user to their provider-side embedded
 * wallet. Both are NULL until Phase C provisions a wallet. These
 * tests pin the Drizzle mirror of the SQL migration — any drift
 * between the migration's CHECK / partial unique index and the
 * TypeScript schema means callers compile against a contract
 * Postgres doesn't actually enforce (or vice versa). The
 * check-migration-parity gate catches catalog drift; these pin the
 * TS-facing narrowing the catalog can't see.
 */
describe('users wallet columns (ADR 030 Phase B / migration 0035)', () => {
  it('walletProvider is nullable, default-free, and narrowed to the vendor union', () => {
    expectTypeOf<UserRow['walletProvider']>().toEqualTypeOf<'privy' | null>();
    expect(users.walletProvider.notNull).toBe(false);
    expect(users.walletProvider.hasDefault).toBe(false);
  });

  it('walletId is nullable and default-free', () => {
    expectTypeOf<UserRow['walletId']>().toEqualTypeOf<string | null>();
    expect(users.walletId.notNull).toBe(false);
    expect(users.walletId.hasDefault).toBe(false);
  });

  it('inserts can omit both wallet columns (pre-Phase-C rows)', () => {
    // Compile-time: nullable + default-free columns are optional on
    // $inferInsert, so every existing user-upsert path keeps
    // compiling without touching the wallet columns.
    const insert: UserInsert = { email: 'user@example.com' };
    expectTypeOf(insert).toMatchTypeOf<UserInsert>();
  });

  it('declares the wallet_provider CHECK mirror', () => {
    const checkNames = getTableConfig(users).checks.map((c) => c.name);
    expect(checkNames).toContain('users_wallet_provider_known');
  });

  it('declares the partial unique index on wallet_id', () => {
    const walletIdIndex = getTableConfig(users).indexes.find(
      (i) => i.config.name === 'users_wallet_id_unique',
    );
    expect(walletIdIndex).toBeDefined();
    expect(walletIdIndex?.config.unique).toBe(true);
    // Partial — the predicate scopes uniqueness to non-NULL ids so
    // the unprovisioned majority of rows don't collide on NULL.
    expect(walletIdIndex?.config.where).toBeDefined();
  });
});

/**
 * ADR 030 Phase C / migration 0037: the wallet-provisioning state
 * machine columns. Same drift-pinning rationale as the Phase-B block
 * above.
 */
describe('users wallet-provisioning columns (ADR 030 Phase C / migration 0037)', () => {
  it('walletAddress is nullable and default-free', () => {
    expectTypeOf<UserRow['walletAddress']>().toEqualTypeOf<string | null>();
    expect(users.walletAddress.notNull).toBe(false);
    expect(users.walletAddress.hasDefault).toBe(false);
  });

  it("walletProvisioning is NOT NULL, defaults to 'none', and is narrowed to the state union", () => {
    expectTypeOf<UserRow['walletProvisioning']>().toEqualTypeOf<
      'none' | 'wallet_created' | 'activated'
    >();
    expect(users.walletProvisioning.notNull).toBe(true);
    expect(users.walletProvisioning.hasDefault).toBe(true);
  });

  it('attempts default to 0; last-attempt timestamp is nullable', () => {
    expectTypeOf<UserRow['walletProvisioningAttempts']>().toEqualTypeOf<number>();
    expect(users.walletProvisioningAttempts.notNull).toBe(true);
    expect(users.walletProvisioningAttempts.hasDefault).toBe(true);
    expectTypeOf<UserRow['walletProvisioningLastAttemptAt']>().toEqualTypeOf<Date | null>();
    expect(users.walletProvisioningLastAttemptAt.notNull).toBe(false);
  });

  it('declares the wallet_provisioning CHECK mirror', () => {
    const checkNames = getTableConfig(users).checks.map((c) => c.name);
    expect(checkNames).toContain('users_wallet_provisioning_known');
  });

  it('declares the partial unique index on wallet_address', () => {
    const idx = getTableConfig(users).indexes.find(
      (i) => i.config.name === 'users_wallet_address_unique',
    );
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.where).toBeDefined();
  });

  it('declares the partial sweeper-scan index on not-yet-activated rows', () => {
    const idx = getTableConfig(users).indexes.find(
      (i) => i.config.name === 'users_wallet_provisioning_pending',
    );
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(false);
    expect(idx?.config.where).toBeDefined();
  });
});
