import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ADMIN_WRITE_MAX_ABS_MINOR } from '../constants';

// FE-11: the ±10,000,000-minor admin money-write cap was duplicated as
// a local `MAX_ABS_MINOR = 10_000_000n` in CreditAdjustmentForm and
// AdminEmissionForm. It is now a single shared constant. These tests
// pin the value (which mirrors the authoritative backend bound in
// apps/backend/src/admin/{credit-adjustments,emissions,refunds}.ts)
// and guard against anyone re-inlining the literal at a call site.

describe('ADMIN_WRITE_MAX_ABS_MINOR', () => {
  it('is ±10,000,000 minor units (100,000 major units), matching the backend cap', () => {
    expect(ADMIN_WRITE_MAX_ABS_MINOR).toBe(10_000_000n);
  });

  const formSources = {
    CreditAdjustmentForm: readFileSync(
      new URL('../CreditAdjustmentForm.tsx', import.meta.url),
      'utf8',
    ),
    AdminEmissionForm: readFileSync(new URL('../AdminEmissionForm.tsx', import.meta.url), 'utf8'),
  };

  for (const [name, source] of Object.entries(formSources)) {
    describe(name, () => {
      it('imports the shared cap constant', () => {
        expect(source).toContain('ADMIN_WRITE_MAX_ABS_MINOR');
        expect(source).toMatch(/from ['"]\.\/constants['"]/);
      });

      it('does not re-inline the 10,000,000 cap literal', () => {
        // Matches 10000000 / 10_000_000 (and a leading minus), the
        // duplicated forms of the cap magnitude this dedup removed.
        expect(source).not.toMatch(/-?10_?000_?000/);
      });
    });
  }
});
