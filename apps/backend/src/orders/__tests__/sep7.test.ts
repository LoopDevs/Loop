import { describe, it, expect } from 'vitest';
import { parseSep7PayUri } from '../sep7.js';

describe('parseSep7PayUri', () => {
  it('parses a well-formed CTX-style URI', () => {
    const r = parseSep7PayUri(
      'web+stellar:pay?destination=GCTX1234&amount=0.1198323&memo=order-abc',
    );
    expect(r).toEqual({
      ok: true,
      value: { destination: 'GCTX1234', amount: '0.1198323', memo: 'order-abc' },
    });
  });

  it('rejects a non-stellar scheme as wrong-scheme', () => {
    const r = parseSep7PayUri('bitcoin:1ABC?amount=0.01');
    expect(r).toEqual({ ok: false, error: 'wrong-scheme' });
  });

  it('rejects a stellar URI without the `pay?` action', () => {
    const r = parseSep7PayUri('web+stellar:tx?xdr=...');
    expect(r).toEqual({ ok: false, error: 'wrong-scheme' });
  });

  it('rejects a URI missing destination', () => {
    const r = parseSep7PayUri('web+stellar:pay?amount=0.1&memo=x');
    expect(r).toEqual({ ok: false, error: 'missing-destination' });
  });

  it('rejects a URI missing amount', () => {
    const r = parseSep7PayUri('web+stellar:pay?destination=GCTX&memo=x');
    expect(r).toEqual({ ok: false, error: 'missing-amount' });
  });

  it('rejects a URI missing memo', () => {
    const r = parseSep7PayUri('web+stellar:pay?destination=GCTX&amount=0.1');
    expect(r).toEqual({ ok: false, error: 'missing-memo' });
  });

  it('percent-decodes the memo once (not twice)', () => {
    // Encoded `order:abc` should yield `order:abc`, not throw on a
    // second decodeURIComponent.
    const r = parseSep7PayUri('web+stellar:pay?destination=GCTX&amount=0.1&memo=order%3Aabc');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.memo).toBe('order:abc');
  });

  it('treats empty-value params as missing (e.g. `memo=`)', () => {
    const r = parseSep7PayUri('web+stellar:pay?destination=GCTX&amount=0.1&memo=');
    expect(r).toEqual({ ok: false, error: 'missing-memo' });
  });

  it('accepts an explicit MEMO_TEXT memo_type', () => {
    const r = parseSep7PayUri(
      'web+stellar:pay?destination=GCTX&amount=0.1&memo=order-1&memo_type=MEMO_TEXT',
    );
    expect(r).toEqual({
      ok: true,
      value: { destination: 'GCTX', amount: '0.1', memo: 'order-1' },
    });
  });

  it('rejects a non-text memo_type as unsupported-memo-type (we only submit text)', () => {
    for (const t of ['MEMO_ID', 'MEMO_HASH', 'MEMO_RETURN', 'id', 'hash']) {
      const r = parseSep7PayUri(
        `web+stellar:pay?destination=GCTX&amount=0.1&memo=123&memo_type=${t}`,
      );
      expect(r).toEqual({ ok: false, error: 'unsupported-memo-type' });
    }
  });
});
