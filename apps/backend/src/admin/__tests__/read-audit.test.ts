import { describe, expect, it } from 'vitest';
import {
  BULK_LIST_ROW_THRESHOLD,
  countAdminListRows,
  sanitizeAdminReadQueryString,
} from '../read-audit.js';

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
