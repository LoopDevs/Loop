import { describe, it, expect, afterEach } from 'vitest';

// The script guards `main()` behind an entry-point check, so importing it
// here does not connect or issue DDL; the guard helpers are pure.
import {
  isProdLookingDatabaseUrl,
  assertEphemeralParityTarget,
} from '../check-migration-parity.js';

const ALLOW_OVERRIDE = 'ALLOW_DESTRUCTIVE_MIGRATION_PARITY';

afterEach(() => {
  delete process.env[ALLOW_OVERRIDE];
});

describe('check-migration-parity DATABASE_URL guard (BK-migparity)', () => {
  const prodLooking = [
    // Remote host with no test marker — the dangerous default case.
    'postgres://user:pw@loop-app-db.internal:5432/loop',
    'postgresql://user:pw@db.prod-cluster.example.com:5432/loop',
    // Explicit production marker in the database name…
    'postgres://user:pw@db.example.com:5432/loop_production',
    // …refused even on a loopback host (prod marker always wins).
    'postgres://loop:loop@localhost:5432/loop_production',
    // Unparseable → cannot prove it's a throwaway.
    'not-a-url',
  ];

  const throwaway = [
    'postgres://loop:loop@localhost:5433/loop_test',
    'postgres://placeholder:placeholder@127.0.0.1:5433/loop',
    'postgres://loop:loop@[::1]:5433/loop',
    'postgres://user:pw@ci-runner.example:5432/loop_parity_scratch',
    'postgres://user:pw@ephemeral-db.example:5432/loop_sandbox',
  ];

  it.each(prodLooking)('flags %s as production-looking', (url) => {
    expect(isProdLookingDatabaseUrl(url)).toBe(true);
  });

  it.each(throwaway)('accepts %s as a throwaway target', (url) => {
    expect(isProdLookingDatabaseUrl(url)).toBe(false);
  });

  it('assertEphemeralParityTarget throws on a prod-looking URL', () => {
    expect(() =>
      assertEphemeralParityTarget('postgres://user:pw@loop-app-db.internal:5432/loop'),
    ).toThrow(/refusing to DROP\/CREATE databases/);
  });

  it('assertEphemeralParityTarget is silent on the documented CI target', () => {
    expect(() =>
      assertEphemeralParityTarget('postgres://loop:loop@localhost:5433/loop_test'),
    ).not.toThrow();
  });

  it('honours the ALLOW_DESTRUCTIVE_MIGRATION_PARITY=1 escape hatch', () => {
    process.env[ALLOW_OVERRIDE] = '1';
    expect(() =>
      assertEphemeralParityTarget('postgres://user:pw@loop-app-db.internal:5432/loop'),
    ).not.toThrow();
  });
});
