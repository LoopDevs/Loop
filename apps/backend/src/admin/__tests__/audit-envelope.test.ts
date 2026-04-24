import { describe, it, expect } from 'vitest';
import { buildAuditEnvelope, type AdminAuditEnvelope } from '../audit-envelope.js';
import type { User } from '../../db/users.js';

/**
 * `buildAuditEnvelope` is a pure shape wrapper — no DB, no side effects
 * — so the tests just pin its contract (A2-1700). The shape is load-
 * bearing for every admin mutation response per ADR-017; any future
 * change to field naming or serialisation needs to be an explicit
 * decision rather than a silent edit.
 */
const ALICE: User = {
  id: 'user-01HXYZ',
  email: 'alice@example.com',
  createdAt: new Date('2026-03-01T00:00:00Z'),
  isAdmin: true,
  homeCurrency: 'USD',
} as unknown as User;

describe('buildAuditEnvelope', () => {
  it('wraps the result with the admin audit header', () => {
    const out = buildAuditEnvelope({
      result: { balance: 1000 },
      actor: ALICE,
      idempotencyKey: 'k'.repeat(32),
      appliedAt: new Date('2026-04-23T12:00:00.000Z'),
      replayed: false,
    });
    const expected: AdminAuditEnvelope<{ balance: number }> = {
      result: { balance: 1000 },
      audit: {
        actorUserId: 'user-01HXYZ',
        actorEmail: 'alice@example.com',
        idempotencyKey: 'k'.repeat(32),
        appliedAt: '2026-04-23T12:00:00.000Z',
        replayed: false,
      },
    };
    expect(out).toEqual(expected);
  });

  it('serialises the appliedAt Date as an ISO-8601 UTC string', () => {
    const out = buildAuditEnvelope({
      result: null,
      actor: ALICE,
      idempotencyKey: 'k'.repeat(32),
      appliedAt: new Date('2026-04-23T12:34:56.789Z'),
      replayed: false,
    });
    expect(out.audit.appliedAt).toBe('2026-04-23T12:34:56.789Z');
    // Round-trippable via Date:
    expect(new Date(out.audit.appliedAt).getTime()).toBe(
      new Date('2026-04-23T12:34:56.789Z').getTime(),
    );
  });

  it('preserves `replayed: true` so the UI can render the distinction', () => {
    const out = buildAuditEnvelope({
      result: { id: 'x' },
      actor: ALICE,
      idempotencyKey: 'k'.repeat(32),
      appliedAt: new Date(),
      replayed: true,
    });
    expect(out.audit.replayed).toBe(true);
  });

  it('passes the result through without copying or mutating it', () => {
    const result = { nested: { counter: 1 } };
    const out = buildAuditEnvelope({
      result,
      actor: ALICE,
      idempotencyKey: 'k'.repeat(32),
      appliedAt: new Date(),
      replayed: false,
    });
    // Same reference — the envelope is not a deep clone.
    expect(out.result).toBe(result);
  });

  it('works for generic result types — primitive, array, null', () => {
    const strEnvelope = buildAuditEnvelope({
      result: 'ok',
      actor: ALICE,
      idempotencyKey: 'k'.repeat(32),
      appliedAt: new Date(),
      replayed: false,
    });
    expect(strEnvelope.result).toBe('ok');

    const arrEnvelope = buildAuditEnvelope({
      result: [1, 2, 3],
      actor: ALICE,
      idempotencyKey: 'k'.repeat(32),
      appliedAt: new Date(),
      replayed: false,
    });
    expect(arrEnvelope.result).toEqual([1, 2, 3]);

    const nullEnvelope = buildAuditEnvelope<null>({
      result: null,
      actor: ALICE,
      idempotencyKey: 'k'.repeat(32),
      appliedAt: new Date(),
      replayed: false,
    });
    expect(nullEnvelope.result).toBeNull();
  });

  it('pins actorEmail from the User (not an alternate arg) — ADR-018 ledger pivot', () => {
    const bob = { ...ALICE, id: 'bob-id', email: 'bob@example.com' } as User;
    const out = buildAuditEnvelope({
      result: {},
      actor: bob,
      idempotencyKey: 'k'.repeat(32),
      appliedAt: new Date(),
      replayed: false,
    });
    expect(out.audit.actorUserId).toBe('bob-id');
    expect(out.audit.actorEmail).toBe('bob@example.com');
  });
});
