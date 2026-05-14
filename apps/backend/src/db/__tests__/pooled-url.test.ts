import { describe, it, expect, vi } from 'vitest';

// db/client.ts touches the env module at import-time (the
// statement_timeout param is read on first load), so the env mocks
// have to set DATABASE_URL before the import.
vi.hoisted(() => {
  process.env['DATABASE_URL'] = 'postgres://placeholder@localhost/test';
});

import { isPooledPostgresUrl } from '../client.js';

describe('isPooledPostgresUrl', () => {
  describe('returns true for known PgBouncer / pooler patterns', () => {
    it('Fly MPG pooler hostname', () => {
      expect(
        isPooledPostgresUrl(
          'postgresql://fly-user:secret@pgbouncer.k1v53olx88eo8q6p.flympg.net/fly-db',
        ),
      ).toBe(true);
    });

    it('Supabase pooler (PgBouncer-mode)', () => {
      expect(
        isPooledPostgresUrl(
          'postgresql://postgres.abcdef:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
        ),
      ).toBe(true);
    });

    it('generic `pgbouncer` substring in hostname', () => {
      expect(isPooledPostgresUrl('postgres://u:p@db-pgbouncer.example.com/app')).toBe(true);
    });

    it('case-insensitive', () => {
      expect(isPooledPostgresUrl('postgres://u:p@PgBouncer.example.com/app')).toBe(true);
    });
  });

  describe('returns false for direct connections', () => {
    it('local docker postgres', () => {
      expect(isPooledPostgresUrl('postgres://loop:loop@localhost:5432/loop')).toBe(false);
    });

    it('Fly MPG direct hostname (non-pgbouncer)', () => {
      expect(
        isPooledPostgresUrl('postgresql://fly-user:secret@k1v53olx88eo8q6p.flympg.net/fly-db'),
      ).toBe(false);
    });

    it('plain RDS-style hostname', () => {
      expect(
        isPooledPostgresUrl(
          'postgres://loop:secret@loop-prod.cluster-xxx.us-east-1.rds.amazonaws.com/loop',
        ),
      ).toBe(false);
    });

    it('substring match guard — "pgbouncer" must be a word, not part of a username', () => {
      // The `\b` word boundaries prevent a connection-string credential
      // that happens to contain the substring from being misclassified.
      expect(isPooledPostgresUrl('postgres://userpgbouncerx:pass@db.example.com/app')).toBe(false);
    });
  });
});
