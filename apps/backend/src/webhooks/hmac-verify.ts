/**
 * Generic HMAC + timestamp webhook verification (Tranche-2 Track A.3).
 *
 * The webhook-vendor-agnostic primitive Track B.3 will use to verify
 * inbound Privy webhooks (and any other modern webhook source). The
 * scheme matches the svix / Stripe / GitHub pattern:
 *
 *   1. Vendor signs `<id>.<timestamp>.<body>` with HMAC-SHA256 using
 *      a shared secret known only to vendor + Loop.
 *   2. Vendor sends the signature in a header (e.g. `Svix-Signature:
 *      v1,<base64>`) plus a timestamp header (e.g. `Svix-Timestamp:
 *      1700000000`) plus an event-id header (e.g. `Svix-Id: msg_…`).
 *   3. Receiver re-computes the HMAC and timing-safe-compares.
 *   4. Receiver rejects timestamps older than a replay window
 *      (default 5 min) so a captured signed message can't be
 *      indefinitely replayed.
 *
 * This module ships the pure-crypto verification logic. Wiring to a
 * specific vendor's header conventions, plus the idempotent
 * event-id dedupe (which needs a `webhook_events` table — out of
 * scope for Track A.3), happens in the per-vendor handler in
 * `webhooks/<vendor>.ts`.
 *
 * Dep-free: built on `node:crypto` primitives. No `svix` /
 * `@privy-io/server-auth` import — those carry vendor lock-in we
 * don't want at the verification layer.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type VerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'malformed_signature_header'
        | 'unsupported_signature_version'
        | 'malformed_timestamp_header'
        | 'replay_window_exceeded'
        | 'bad_signature';
    };

export interface VerifyArgs {
  /** Webhook signing secret shared with the vendor. Min 16 bytes recommended. */
  secret: string;
  /** Vendor-supplied event id (e.g. `msg_xxx`). Used as the first segment of the signed input. */
  id: string;
  /** Vendor-supplied unix timestamp string (seconds). The receiver checks the replay window against this. */
  timestamp: string;
  /** Raw HTTP body bytes — HMAC is over the body verbatim, not its parsed form. */
  body: string | Buffer;
  /**
   * Vendor-supplied signature header value. The svix convention is
   * `v1,<base64>` (sometimes `v1,<base64> v1,<base64>` for rotation);
   * pass the whole header value and the parser will extract the v1
   * candidates. Other versions are not yet supported — callers
   * should reject if the vendor adds v2.
   */
  signatureHeader: string;
  /**
   * Replay-window in seconds. Default 300 (5 min). Set lower for
   * vendors that retry rapidly; do not exceed 600 — past that the
   * captured-signature replay window starts to matter.
   */
  toleranceSeconds?: number;
  /** Override `now` for tests; seconds since epoch. */
  nowSeconds?: number;
}

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;
const MAX_TOLERANCE_SECONDS = 10 * 60;

/**
 * Verifies a webhook delivery by HMAC + timestamp. Returns
 * `{ok:true}` only when the signature matches AND the timestamp is
 * inside the replay window. The caller still has to dedupe by the
 * `id` parameter against a persisted set — this function does not
 * gate replay-of-old-already-processed events.
 *
 * Constant-time signature comparison via `timingSafeEqual` —
 * standard precaution for HMAC verification of attacker-supplied
 * input.
 */
export function verifyHmacWebhook(args: VerifyArgs): VerifyResult {
  const tolerance = Math.min(
    args.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS,
    MAX_TOLERANCE_SECONDS,
  );
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);

  // Timestamp parse + replay-window check first — cheaper than HMAC,
  // and rejecting a stale-but-correctly-signed replay before doing
  // the crypto work avoids any timing leakage from the HMAC compare.
  const ts = Number(args.timestamp);
  if (!Number.isFinite(ts) || !Number.isInteger(ts)) {
    return { ok: false, reason: 'malformed_timestamp_header' };
  }
  if (Math.abs(now - ts) > tolerance) {
    return { ok: false, reason: 'replay_window_exceeded' };
  }

  // Parse the signature header. Format: `v1,<base64> [v1,<base64> ...]`.
  // Multiple v1 entries indicate vendor-side key rotation — accept any
  // match. Anything other than v1 is rejected explicitly so a vendor
  // bumping to v2 doesn't silently fall through to the legacy path.
  const candidates: Buffer[] = [];
  for (const part of args.signatureHeader.split(/\s+/)) {
    if (part.length === 0) continue;
    const commaIdx = part.indexOf(',');
    if (commaIdx === -1) {
      return { ok: false, reason: 'malformed_signature_header' };
    }
    const version = part.slice(0, commaIdx);
    const sigB64 = part.slice(commaIdx + 1);
    if (version !== 'v1') {
      return { ok: false, reason: 'unsupported_signature_version' };
    }
    if (sigB64.length === 0) {
      return { ok: false, reason: 'malformed_signature_header' };
    }
    let decoded: Buffer;
    try {
      decoded = Buffer.from(sigB64, 'base64');
    } catch {
      return { ok: false, reason: 'malformed_signature_header' };
    }
    candidates.push(decoded);
  }
  if (candidates.length === 0) {
    return { ok: false, reason: 'malformed_signature_header' };
  }

  // HMAC-SHA256 over `<id>.<timestamp>.<body>`. Body is taken
  // verbatim — JSON re-stringification by the receiver would change
  // the bytes and break verification, so callers MUST capture the
  // raw body before any framework auto-parses it.
  const bodyStr = typeof args.body === 'string' ? args.body : args.body.toString('utf8');
  const signedInput = `${args.id}.${args.timestamp}.${bodyStr}`;
  const expected = createHmac('sha256', args.secret).update(signedInput).digest();

  for (const candidate of candidates) {
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'bad_signature' };
}
