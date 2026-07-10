import { describe, expect, it } from 'vitest';
import {
  BULK_LIST_ROW_THRESHOLD,
  PER_PATH_BULK_ROW_THRESHOLD,
  bulkRowThresholdFor,
  countAdminListRows,
  sanitizeAdminReadQueryString,
} from '../read-audit.js';
import { RESULT_LIMIT as USER_SEARCH_RESULT_LIMIT } from '../user-search.js';

describe('sanitizeAdminReadQueryString', () => {
  it('returns undefined for an empty query string', () => {
    expect(sanitizeAdminReadQueryString('')).toBeUndefined();
  });

  it('redacts email-bearing params while preserving the filter keys', () => {
    expect(sanitizeAdminReadQueryString('email=user@example.com')).toBe('email=%5BREDACTED%5D');
    expect(sanitizeAdminReadQueryString('q=alice@example.com&limit=20')).toBe(
      'limit=20&q=%5BREDACTED%5D',
    );
  });

  it('leaves non-PII params untouched', () => {
    expect(sanitizeAdminReadQueryString('state=failed&limit=20')).toBe('state=failed&limit=20');
  });
});

describe('countAdminListRows (CF-10)', () => {
  const JSON_CT = 'application/json; charset=utf-8';

  it('counts the rows under a single top-level array property', () => {
    const body = JSON.stringify({ users: [{ id: '1' }, { id: '2' }, { id: '3' }] });
    expect(countAdminListRows(body, JSON_CT)).toBe(3);
  });

  it('takes the largest top-level array when several are present', () => {
    const body = JSON.stringify({ since: '2026-01-01', rows: [1, 2, 3, 4], meta: [1] });
    expect(countAdminListRows(body, JSON_CT)).toBe(4);
  });

  it('counts a bare top-level array', () => {
    expect(countAdminListRows(JSON.stringify([1, 2, 3]), JSON_CT)).toBe(3);
  });

  it('returns 0 for single-row drill objects (no top-level array)', () => {
    const body = JSON.stringify({ id: 'p-1', state: 'failed', attempts: 2 });
    expect(countAdminListRows(body, JSON_CT)).toBe(0);
  });

  it('returns 0 for non-JSON content types (e.g. CSV)', () => {
    expect(countAdminListRows('a,b,c\n1,2,3', 'text/csv')).toBe(0);
  });

  it('returns 0 for a null content type', () => {
    expect(countAdminListRows('{"rows":[1,2]}', null)).toBe(0);
  });

  it('returns 0 (never throws) for an unparseable body', () => {
    expect(countAdminListRows('not json {', JSON_CT)).toBe(0);
  });

  it('returns 0 for a JSON scalar / null', () => {
    expect(countAdminListRows('null', JSON_CT)).toBe(0);
    expect(countAdminListRows('42', JSON_CT)).toBe(0);
  });

  it('flags a near-max page as bulk via the threshold', () => {
    const rows = Array.from({ length: BULK_LIST_ROW_THRESHOLD }, (_, i) => ({ id: String(i) }));
    expect(countAdminListRows(JSON.stringify({ users: rows }), JSON_CT)).toBeGreaterThanOrEqual(
      BULK_LIST_ROW_THRESHOLD,
    );
  });
});

// ADMIN-02 (2026-06-30 cold audit): admin/users/search hard-caps its own
// response at RESULT_LIMIT (20) rows, permanently below
// BULK_LIST_ROW_THRESHOLD (50) — structurally invisible to the generic
// tripwire regardless of query breadth or call volume. A per-path
// threshold override closes this for the one endpoint that needs it.
describe('bulkRowThresholdFor (ADMIN-02)', () => {
  it('falls back to the global threshold for an endpoint with no override', () => {
    expect(bulkRowThresholdFor('/api/admin/users')).toBe(BULK_LIST_ROW_THRESHOLD);
    expect(bulkRowThresholdFor('/api/admin/payouts')).toBe(BULK_LIST_ROW_THRESHOLD);
  });

  it("uses the per-path override for admin/users/search, set below the endpoint's own row cap", () => {
    const override = bulkRowThresholdFor('/api/admin/users/search');
    expect(override).toBe(PER_PATH_BULK_ROW_THRESHOLD['/api/admin/users/search']);
    // The whole point of the fix: user-search's RESULT_LIMIT (20) must
    // exceed the override so a full page always trips the tripwire —
    // if this ever regresses back to >= RESULT_LIMIT, the endpoint
    // becomes invisible to the tripwire again exactly like before.
    expect(override).toBeLessThan(USER_SEARCH_RESULT_LIMIT);
    expect(override).toBeLessThan(BULK_LIST_ROW_THRESHOLD);
  });

  it('a full user-search page (RESULT_LIMIT rows) now counts as bulk', () => {
    const rows = Array.from({ length: USER_SEARCH_RESULT_LIMIT }, (_, i) => ({ id: String(i) }));
    const rowCount = countAdminListRows(
      JSON.stringify({ users: rows, truncated: false }),
      'application/json; charset=utf-8',
    );
    expect(rowCount).toBeGreaterThanOrEqual(bulkRowThresholdFor('/api/admin/users/search'));
    // Before the fix this same page would NOT have tripped the global
    // 50-row threshold.
    expect(rowCount).toBeLessThan(BULK_LIST_ROW_THRESHOLD);
  });
});

// A5-8 P2 follow-up: the opposite collision from ADMIN-02 above.
// `admin/ledger.ts`'s DEFAULT_LIMIT (50) equals the global
// BULK_LIST_ROW_THRESHOLD (50), so every default-size page trips the
// tripwire — not just a broad/paginated pull. The override raises the
// effective threshold above the endpoint's own default so routine
// support-triage opens stay log-only, while an explicit wide
// `?limit=` request (up to the endpoint's real MAX_LIMIT of 200)
// still trips it.
describe('bulkRowThresholdFor (A5-8 P2 — ledger default-page collision)', () => {
  const LEDGER_DEFAULT_LIMIT = 50;

  it("uses a per-path override for /api/admin/ledger, set ABOVE the endpoint's own default page size", () => {
    const override = bulkRowThresholdFor('/api/admin/ledger');
    expect(override).toBe(PER_PATH_BULK_ROW_THRESHOLD['/api/admin/ledger']);
    expect(override).toBeGreaterThan(LEDGER_DEFAULT_LIMIT);
    // Still well below the endpoint's real ceiling — a wide explicit
    // pull remains visible to the tripwire.
    expect(override).toBeLessThan(200);
  });

  it('a default-size ledger page (50 rows) no longer counts as bulk', () => {
    const rows = Array.from({ length: LEDGER_DEFAULT_LIMIT }, (_, i) => ({ id: String(i) }));
    const rowCount = countAdminListRows(
      JSON.stringify({ transactions: rows }),
      'application/json; charset=utf-8',
    );
    expect(rowCount).toBe(LEDGER_DEFAULT_LIMIT);
    // Before the fix this exact page (rowCount === global threshold)
    // WOULD have tripped the tripwire (isBulkList = rowCount >=
    // threshold). The override closes that.
    expect(rowCount).toBeLessThan(bulkRowThresholdFor('/api/admin/ledger'));
  });

  it('an explicit wide ledger pull (near MAX_LIMIT) still counts as bulk', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: String(i) }));
    const rowCount = countAdminListRows(
      JSON.stringify({ transactions: rows }),
      'application/json; charset=utf-8',
    );
    expect(rowCount).toBeGreaterThanOrEqual(bulkRowThresholdFor('/api/admin/ledger'));
  });
});
