/**
 * SEC-02-stepup (auth privilege) — DB-backed proof of the two
 * properties `consumeAdminStepUpToken` adds to the admin step-up token.
 *
 * The audited disease: one OTP minted a 5-minute step-up token that was
 * (a) ALL-CLASS — the default `'admin-write'` wildcard scope satisfied
 * every gate, so a token minted to "queue an emission" could be
 * replayed for a refund/payout/credit-adjust — and (b) UNLIMITED-USE —
 * the token was stateless, so it could be replayed any number of times
 * inside the window.
 *
 * `consumeAdminStepUpToken` is the DB-backed, security-authoritative
 * check that closes both holes:
 *   1. a token minted for class A is REJECTED when presented for
 *      class B (`scope_mismatch`), with no wildcard bypass; and
 *   2. a token is SINGLE-USE — a second presentation of the same token
 *      is rejected (`already_consumed`), enforced atomically via the
 *      `admin_step_up_consumptions` primary-key on `jti`.
 *
 * Real postgres (the `admin_step_up_consumptions` ledger + its ON
 * CONFLICT DO NOTHING consume) is what makes single-use provable, so
 * this lives in the integration suite (LOOP_E2E_DB=1) rather than the
 * placeholder-DB unit suite.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createHmac } from 'node:crypto';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

import { db } from '../../db/client.js';
import { adminStepUpConsumptions } from '../../db/schema.js';
import { signAdminStepUpToken, consumeAdminStepUpToken } from '../../auth/admin-step-up.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

const ADMIN_SUB = '11111111-1111-4111-8111-111111111111';

describeIf('SEC-02-stepup: consumeAdminStepUpToken — class binding + single-use (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  // ── Property 1: action-class binding (no all-class privilege) ──

  it('rejects a token minted for one action-class when presented for another (scope_mismatch)', async () => {
    // Minted to approve a REFUND; an attacker replays it against a
    // WITHDRAWAL — the exact "one token, any write" replay the finding
    // describes.
    const { token } = signAdminStepUpToken({
      sub: ADMIN_SUB,
      email: 'admin@test.local',
      scope: 'refund',
    });

    const result = await consumeAdminStepUpToken({ token, action: 'withdrawal' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scope_mismatch');

    // A rejected presentation consumes nothing — the token wasn't valid
    // for this action, so no jti is burned.
    const rows = await db.select().from(adminStepUpConsumptions);
    expect(rows).toHaveLength(0);
  });

  it('rejects the wildcard (all-class default) token for a concrete action — the audited all-class privilege', async () => {
    // No scope passed → the `'admin-write'` wildcard default, which is
    // exactly what the OTP mint produced before this fix and what made
    // the token all-class. It must NOT satisfy a concrete gate.
    const { token, claims } = signAdminStepUpToken({
      sub: ADMIN_SUB,
      email: 'admin@test.local',
    });
    expect(claims.scope).toBe('admin-write');

    const result = await consumeAdminStepUpToken({ token, action: 'refund' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scope_mismatch');
  });

  it('accepts a token presented for the exact class it was minted for', async () => {
    const { token, claims } = signAdminStepUpToken({
      sub: ADMIN_SUB,
      email: 'admin@test.local',
      scope: 'emission',
    });

    const result = await consumeAdminStepUpToken({ token, action: 'emission' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.scope).toBe('emission');

    // Exactly the consumed token's jti is recorded, tagged with its
    // subject + class for forensics.
    const rows = await db.select().from(adminStepUpConsumptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.jti).toBe(claims.jti);
    expect(rows[0]!.sub).toBe(ADMIN_SUB);
    expect(rows[0]!.scope).toBe('emission');
  });

  // ── Property 2: single-use ──

  it('is single-use — a second presentation of the same token is rejected (already_consumed)', async () => {
    const { token, claims } = signAdminStepUpToken({
      sub: ADMIN_SUB,
      email: 'admin@test.local',
      scope: 'payout-retry',
    });

    const first = await consumeAdminStepUpToken({ token, action: 'payout-retry' });
    expect(first.ok).toBe(true);

    const second = await consumeAdminStepUpToken({ token, action: 'payout-retry' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already_consumed');

    // The ledger holds exactly one row for the jti — the replay did not
    // write a second.
    const rows = await db
      .select()
      .from(adminStepUpConsumptions)
      .where(eq(adminStepUpConsumptions.jti, claims.jti!));
    expect(rows).toHaveLength(1);
  });

  it('two concurrent presentations of the same token resolve to exactly one success', async () => {
    // The atomic-consume idiom must hold under a race: fire both before
    // awaiting either so they contend on the jti primary key.
    const { token } = signAdminStepUpToken({
      sub: ADMIN_SUB,
      email: 'admin@test.local',
      scope: 'credit-adjustment',
    });

    const [a, b] = await Promise.all([
      consumeAdminStepUpToken({ token, action: 'credit-adjustment' }),
      consumeAdminStepUpToken({ token, action: 'credit-adjustment' }),
    ]);

    const oks = [a.ok, b.ok].filter((ok) => ok === true);
    expect(oks).toHaveLength(1);
    const rows = await db.select().from(adminStepUpConsumptions);
    expect(rows).toHaveLength(1);
  });

  it('fails a legacy jti-less token closed (not_consumable) rather than granting unlimited use', async () => {
    // A token minted before the `jti` claim existed verifies fine but
    // can't be tracked single-use. `signAdminStepUpToken` always stamps
    // a jti now, so hand-craft a scope-correct token with NO `jti` field
    // (a pre-SEC-02 wire token) signed with the integration key, and
    // confirm the consume path fails CLOSED instead of granting an
    // untracked, unlimited-use token.
    const key = process.env['LOOP_ADMIN_STEP_UP_SIGNING_KEY']!;
    const b64 = (o: unknown): string =>
      Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'HS256', typ: 'JWT' });
    const payload = b64({
      sub: ADMIN_SUB,
      email: 'admin@test.local',
      purpose: 'admin-step-up',
      aud: 'admin-write',
      iss: 'loop-api',
      scope: 'emission',
      // no `jti`
      iat: now,
      exp: now + 300,
    });
    const sig = createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url');
    const legacyToken = `${header}.${payload}.${sig}`;

    const result = await consumeAdminStepUpToken({ token: legacyToken, action: 'emission' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_consumable');

    // Fail-closed means it burns nothing either.
    const rows = await db.select().from(adminStepUpConsumptions);
    expect(rows).toHaveLength(0);
  });
});
