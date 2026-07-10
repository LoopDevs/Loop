import { describe, it, expect } from 'vitest';
import {
  decodeAuditCursor,
  encodeAuditCursor,
  type AdminAuditTimelineCursor,
} from './admin-support-ops.js';

describe('audit cursor codec (A5-7 compound keyset)', () => {
  it('round-trips a plain uuid-id cursor', () => {
    const c: AdminAuditTimelineCursor = {
      at: '2026-07-05T00:00:00.000Z',
      id: '11111111-2222-3333-4444-555555555555',
    };
    expect(decodeAuditCursor(encodeAuditCursor(c))).toEqual(c);
  });

  it('encodes as "<iso>|<id>"', () => {
    expect(encodeAuditCursor({ at: '2026-07-05T00:00:00.000Z', id: 'jti-07' })).toBe(
      '2026-07-05T00:00:00.000Z|jti-07',
    );
  });

  it('splits on the FIRST separator so an id containing "|" survives', () => {
    // An admin_idempotency_keys tiebreaker is an opaque client token
    // and may itself contain "|"; the ISO timestamp never does, so the
    // first "|" is always the real boundary.
    const c: AdminAuditTimelineCursor = { at: '2026-07-05T00:00:00.000Z', id: 'weird|key|123' };
    const decoded = decodeAuditCursor(encodeAuditCursor(c));
    expect(decoded).toEqual(c);
    expect(decoded?.id).toBe('weird|key|123');
  });

  it('returns null on a malformed token (no separator, or an empty half)', () => {
    expect(decodeAuditCursor('no-separator')).toBeNull();
    expect(decodeAuditCursor('|id-only')).toBeNull(); // empty timestamp half
    expect(decodeAuditCursor('2026-07-05T00:00:00.000Z|')).toBeNull(); // empty id half
    expect(decodeAuditCursor('')).toBeNull();
  });
});
