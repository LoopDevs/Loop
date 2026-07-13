import { describe, it, expect, vi } from 'vitest';

// The walk imports a large graph rooted at `../db/client.js`, which
// builds a Postgres pool at module scope. Stub it so importing the pure
// `isProdLookingDatabaseUrl` guard stays side-effect free. The walk's
// top-level runner is guarded behind an entry-point check, so importing
// it here does not run the walk or `process.exit()`.
vi.mock('../../db/client.js', () => ({
  db: {},
  runMigrations: vi.fn(),
  closeDb: vi.fn(),
}));

import { isProdLookingDatabaseUrl } from '../wallet-testnet-walk.js';

// The Step 0 guard rail refuses to run when `isProdLookingDatabaseUrl`
// returns true for `env.DATABASE_URL` (absent the override), so proving
// the predicate rejects prod-looking URLs proves the guard rejects them.
describe('wallet-testnet-walk DATABASE_URL guard (BK-testnetwalk)', () => {
  it.each([
    'postgres://user:pw@loop-app-db.internal:5432/loop',
    'postgresql://user:pw@db.prod-cluster.example.com:5432/loop',
    'postgres://user:pw@db.example.com:5432/loop_production',
    'postgres://loop:loop@localhost:5432/loop_production',
    'not-a-url',
  ])('flags %s as production-looking (walk refuses to run)', (url) => {
    expect(isProdLookingDatabaseUrl(url)).toBe(true);
  });

  it.each([
    'postgres://loop:loop@localhost:5433/loop_test',
    'postgres://placeholder:placeholder@127.0.0.1:5433/loop',
    'postgres://user:pw@ci-runner.example:5432/wallet_walk_scratch',
  ])('accepts %s as a scratch/testnet target', (url) => {
    expect(isProdLookingDatabaseUrl(url)).toBe(false);
  });
});
