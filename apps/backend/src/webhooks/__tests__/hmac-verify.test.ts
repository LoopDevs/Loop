import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';

import { verifyHmacWebhook } from '../hmac-verify.js';

const SECRET = 's'.repeat(32);

function sign(id: string, timestamp: string, body: string): string {
  return createHmac('sha256', SECRET)
    .update(`${id}.${timestamp}.${body}`)
    .digest()
    .toString('base64');
}

const FIXED_NOW = 1_800_000_000;
const RECENT_TS = String(FIXED_NOW - 30); // 30 s ago — well inside default window

describe('verifyHmacWebhook', () => {
  describe('happy path', () => {
    it('accepts a correctly-signed delivery within the replay window', () => {
      const body = '{"event":"wallet.created","id":"u-1"}';
      const sig = sign('msg_abc', RECENT_TS, body);
      const result = verifyHmacWebhook({
        secret: SECRET,
        id: 'msg_abc',
        timestamp: RECENT_TS,
        body,
        signatureHeader: `v1,${sig}`,
        nowSeconds: FIXED_NOW,
      });
      expect(result).toEqual({ ok: true });
    });

    it('accepts the signature when the header carries multiple v1 candidates (rotation)', () => {
      // Vendor sends both old + new key signatures during a rotation
      // window. The new key matches; the old one is wrong but the
      // function should accept on first match.
      const body = '{}';
      const sigNew = sign('msg_x', RECENT_TS, body);
      const sigOld = 'AAAA'.repeat(11); // 44 base64 chars = 33 bytes — wrong length, won't match
      const result = verifyHmacWebhook({
        secret: SECRET,
        id: 'msg_x',
        timestamp: RECENT_TS,
        body,
        signatureHeader: `v1,${sigOld} v1,${sigNew}`,
        nowSeconds: FIXED_NOW,
      });
      expect(result).toEqual({ ok: true });
    });

    it('accepts a Buffer body equivalent to the string-body case', () => {
      const body = Buffer.from('{"k":"v"}', 'utf8');
      const sig = sign('msg', RECENT_TS, '{"k":"v"}');
      const result = verifyHmacWebhook({
        secret: SECRET,
        id: 'msg',
        timestamp: RECENT_TS,
        body,
        signatureHeader: `v1,${sig}`,
        nowSeconds: FIXED_NOW,
      });
      expect(result).toEqual({ ok: true });
    });
  });

  describe('signature rejection', () => {
    it('rejects a delivery with a tampered signature', () => {
      const body = '{}';
      // Sign for a different body — re-encode the captured signature
      // and present it as if it were for `body`.
      const sig = sign('msg', RECENT_TS, '{"different":"payload"}');
      const result = verifyHmacWebhook({
        secret: SECRET,
        id: 'msg',
        timestamp: RECENT_TS,
        body,
        signatureHeader: `v1,${sig}`,
        nowSeconds: FIXED_NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('rejects a delivery signed with the wrong secret', () => {
      const body = '{}';
      const wrongSig = createHmac('sha256', 'wrong-secret-32-bytes-x'.repeat(2))
        .update(`msg.${RECENT_TS}.${body}`)
        .digest()
        .toString('base64');
      const result = verifyHmacWebhook({
        secret: SECRET,
        id: 'msg',
        timestamp: RECENT_TS,
        body,
        signatureHeader: `v1,${wrongSig}`,
        nowSeconds: FIXED_NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'bad_signature' });
    });
  });

  describe('replay-window enforcement', () => {
    it('rejects a timestamp older than the default 5-min window', () => {
      const oldTs = String(FIXED_NOW - 6 * 60);
      const body = '{}';
      const sig = sign('msg', oldTs, body);
      const result = verifyHmacWebhook({
        secret: SECRET,
        id: 'msg',
        timestamp: oldTs,
        body,
        signatureHeader: `v1,${sig}`,
        nowSeconds: FIXED_NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'replay_window_exceeded' });
    });

    it('rejects a timestamp from the future beyond the window', () => {
      const futureTs = String(FIXED_NOW + 6 * 60);
      const body = '{}';
      const sig = sign('msg', futureTs, body);
      const result = verifyHmacWebhook({
        secret: SECRET,
        id: 'msg',
        timestamp: futureTs,
        body,
        signatureHeader: `v1,${sig}`,
        nowSeconds: FIXED_NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'replay_window_exceeded' });
    });

    it('clamps caller-requested tolerance to the 10-min hard ceiling', () => {
      const oldTs = String(FIXED_NOW - 11 * 60);
      const body = '{}';
      const sig = sign('msg', oldTs, body);
      // Caller asks for an hour-long window; the clamp cuts it to 10
      // min, so an 11-min-old timestamp still fails.
      const result = verifyHmacWebhook({
        secret: SECRET,
        id: 'msg',
        timestamp: oldTs,
        body,
        signatureHeader: `v1,${sig}`,
        toleranceSeconds: 60 * 60,
        nowSeconds: FIXED_NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'replay_window_exceeded' });
    });

    it('respects a tighter caller-requested tolerance', () => {
      const oldTs = String(FIXED_NOW - 90); // 90s ago
      const body = '{}';
      const sig = sign('msg', oldTs, body);
      const result = verifyHmacWebhook({
        secret: SECRET,
        id: 'msg',
        timestamp: oldTs,
        body,
        signatureHeader: `v1,${sig}`,
        toleranceSeconds: 60, // 60s window
        nowSeconds: FIXED_NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'replay_window_exceeded' });
    });
  });

  describe('header-format rejection', () => {
    it('rejects a malformed timestamp header', () => {
      const result = verifyHmacWebhook({
        secret: SECRET,
        id: 'msg',
        timestamp: 'not-a-number',
        body: '{}',
        signatureHeader: `v1,${'A'.repeat(44)}`,
        nowSeconds: FIXED_NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'malformed_timestamp_header' });
    });

    it('rejects a non-integer timestamp', () => {
      const result = verifyHmacWebhook({
        secret: SECRET,
        id: 'msg',
        timestamp: '1700000000.5',
        body: '{}',
        signatureHeader: `v1,${'A'.repeat(44)}`,
        nowSeconds: FIXED_NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'malformed_timestamp_header' });
    });

    it('rejects a signature header without the version prefix', () => {
      const result = verifyHmacWebhook({
        secret: SECRET,
        id: 'msg',
        timestamp: RECENT_TS,
        body: '{}',
        signatureHeader: 'A'.repeat(44), // no `v1,`
        nowSeconds: FIXED_NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'malformed_signature_header' });
    });

    it('rejects an unsupported signature version', () => {
      const result = verifyHmacWebhook({
        secret: SECRET,
        id: 'msg',
        timestamp: RECENT_TS,
        body: '{}',
        signatureHeader: `v2,${'A'.repeat(44)}`,
        nowSeconds: FIXED_NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'unsupported_signature_version' });
    });

    it('rejects an empty signature header', () => {
      const result = verifyHmacWebhook({
        secret: SECRET,
        id: 'msg',
        timestamp: RECENT_TS,
        body: '{}',
        signatureHeader: '',
        nowSeconds: FIXED_NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'malformed_signature_header' });
    });

    it('rejects a v1 entry with empty signature bytes', () => {
      const result = verifyHmacWebhook({
        secret: SECRET,
        id: 'msg',
        timestamp: RECENT_TS,
        body: '{}',
        signatureHeader: 'v1,',
        nowSeconds: FIXED_NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'malformed_signature_header' });
    });
  });
});
