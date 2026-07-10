import { describe, it, expect, afterEach, vi } from 'vitest';
import { generateIdempotencyKey } from '../admin-write-envelope';

/**
 * Q6-3: direct coverage for the ADR-017 admin-write `Idempotency-Key`
 * primitive. This module is the lowest-leverage layer of the
 * client-side admin-write envelope — every writer
 * (`applyCreditAdjustment`, `applyAdminEmission`, `redriveOrder`,
 * `retryPayout`, `clearAdminOtpLockout`) calls `generateIdempotencyKey()`
 * to mint the key it sends on `Idempotency-Key`, and the step-up retry
 * contract (CF-09) depends on callers REUSING one generated key across
 * a retry rather than calling this function again. See
 * `docs/adr/017-admin-credit-primitives.md` §2.
 */
describe('generateIdempotencyKey', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a non-empty string', () => {
    const key = generateIdempotencyKey();
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
  });

  it('returns a different key on every call (never reuses without being told to)', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateIdempotencyKey()));
    // 50 independent calls must produce 50 distinct keys — a collision
    // here would mean the generator is broken (e.g. hardcoded), which
    // would silently break ADR-017 dedup for unrelated writes.
    expect(keys.size).toBe(50);
  });

  it('uses crypto.randomUUID with hyphens stripped when available', () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => '123e4567-e89b-12d3-a456-426614174000',
    });
    const key = generateIdempotencyKey();
    expect(key).toBe('123e4567e89b12d3a456426614174000');
    expect(key).not.toContain('-');
    expect(key).toHaveLength(32);
  });

  it('falls back to a time+random token when crypto.randomUUID is unavailable', () => {
    // Simulates a non-browser / older test environment where `crypto`
    // exists but has no `randomUUID` (the guard the function checks).
    vi.stubGlobal('crypto', {});
    const key = generateIdempotencyKey();
    // Fallback shape: `${Date.now()}-${rand}-${rand}` — still opaque to
    // the backend, but structurally different from the UUID path.
    expect(key).toMatch(/^\d+-[a-z0-9]+-[a-z0-9]+$/);
  });

  it('falls back when crypto itself is undefined', () => {
    vi.stubGlobal('crypto', undefined);
    const key = generateIdempotencyKey();
    expect(key).toMatch(/^\d+-[a-z0-9]+-[a-z0-9]+$/);
  });

  it('the fallback also produces distinct keys across calls', () => {
    vi.stubGlobal('crypto', undefined);
    const a = generateIdempotencyKey();
    const b = generateIdempotencyKey();
    expect(a).not.toBe(b);
  });
});
