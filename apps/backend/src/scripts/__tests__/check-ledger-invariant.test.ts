import { describe, it, expect, vi } from 'vitest';

// The script imports `../db/client.js` at load, which builds a Postgres
// pool from `env` at module scope. Stub it so importing the pure
// `formatDriftReport` helper stays side-effect free. The script's own
// top-level `main()` is guarded behind an entry-point check, so importing
// it here does not run the CLI. (Same pattern as quarterly-tax-parse.test.)
vi.mock('../../db/client.js', () => ({
  db: { execute: vi.fn() },
  closeDb: vi.fn(),
}));

import { formatDriftReport } from '../check-ledger-invariant.js';
import type { DriftEntry } from '../../credits/ledger-invariant.js';

function drift(userId: string): DriftEntry {
  return {
    userId,
    currency: 'GBP',
    balanceMinor: '100',
    ledgerSumMinor: '90',
    deltaMinor: '10',
  };
}

describe('check-ledger-invariant formatDriftReport (DAT-09)', () => {
  it('reports the exact count and every row when under the display limit', () => {
    const rows = [drift('u1'), drift('u2')];
    const { code, lines } = formatDriftReport(rows, 5);
    expect(code).toBe(1);
    expect(lines[0]).toBe('DRIFT: 2 (user, currency) pair(s) out of sync with ledger sum.');
    // Both drift rows are present; no truncation notice.
    expect(lines.filter((l) => l.startsWith('  user=')).length).toBe(2);
    expect(lines.some((l) => l.includes('truncated'))).toBe(false);
  });

  it('returns OK / exit 0 when there is no drift', () => {
    const { code, lines } = formatDriftReport([], 5);
    expect(code).toBe(0);
    expect(lines).toEqual(['OK: ledger invariant holds — no drift detected.']);
  });

  it('does NOT silently present the cap as the true count when truncated', () => {
    // `main` fetches displayLimit + 1 rows; here displayLimit=2 and we
    // pass 3 rows, standing in for "more than 2 drifted pairs exist".
    // The old script printed `DRIFT: 2 …` (the cap) with no hint the
    // report was cut — this asserts the corrected, honest behaviour.
    const rows = [drift('u1'), drift('u2'), drift('u3')];
    const { code, lines } = formatDriftReport(rows, 2);
    expect(code).toBe(1);
    // Count line must NOT claim an exact "3" or a capped "2"; it must
    // flag that the true count is higher than the shown rows.
    expect(lines[0]).toBe(
      'DRIFT: more than 2 (user, currency) pair(s) out of sync with ledger sum.',
    );
    // Only the first `displayLimit` detail rows are printed…
    expect(lines.filter((l) => l.startsWith('  user=')).length).toBe(2);
    // …and the truncation is made explicit.
    expect(lines.some((l) => l.includes('truncated') && l.includes('true count is higher'))).toBe(
      true,
    );
  });

  it('prints all rows and no notice when exactly at the display limit', () => {
    const rows = [drift('u1'), drift('u2')];
    const { lines } = formatDriftReport(rows, 2);
    expect(lines[0]).toBe('DRIFT: 2 (user, currency) pair(s) out of sync with ledger sum.');
    expect(lines.some((l) => l.includes('truncated'))).toBe(false);
  });
});
