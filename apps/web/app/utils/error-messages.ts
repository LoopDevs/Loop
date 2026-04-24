import { ApiException } from '@loop/shared';

/**
 * Code-to-user-message map. A2-1153: the backend emits a bespoke
 * `{ code, message }` taxonomy (docs/error-codes.md) but the web has
 * historically only branched on HTTP status. Several codes deserve a
 * distinct UX string — the generic 400 copy ("Please check and try
 * again") is misleading when the real cause is `INSUFFICIENT_CREDIT`
 * or `HOME_CURRENCY_LOCKED`.
 *
 * Only codes with a meaningfully different prompt land here. The
 * backend's `message` field is already user-friendly for generic
 * 400s (VALIDATION_ERROR echoes the Zod issue) — overriding those
 * would lose context. Specific codes get a copywriter-controlled
 * string instead.
 *
 * `null` values opt a code OUT of the map — we explicitly want to
 * fall through to the backend's `message`, not override it.
 */
const CODE_MESSAGES: Record<string, string | null> = {
  // Money / state codes — the backend message is terse and
  // server-speak; give the user the action-oriented copy.
  INSUFFICIENT_CREDIT:
    "Your cashback balance doesn't cover this order. Pay another way or earn more first.",
  INSUFFICIENT_BALANCE: "The user's balance is below the requested amount.",
  HOME_CURRENCY_LOCKED:
    'Your home currency is locked after your first order — contact support if you need it changed.',
  REFUND_ALREADY_ISSUED: 'A refund has already been issued for this order.',
  ALREADY_COMPENSATED: 'This failed payout has already been compensated.',

  // Config / availability — point at the operator, not the user.
  ASSET_NOT_CONFIGURED:
    'This asset is not configured on the backend. Try again after ops sets it up.',
  WEBHOOK_NOT_CONFIGURED: 'This webhook is not configured.',
  NOT_CONFIGURED: 'A required config value is missing on the backend.',

  // Transport / payload — explicit about the ceiling.
  PAYLOAD_TOO_LARGE: 'That upload is too large. The server caps request bodies at 1 MB.',
  IMAGE_TOO_LARGE: 'That image is too large to proxy (server cap is 10 MB).',

  // Generic client-surfaced codes.
  RATE_LIMITED: 'Too many attempts. Please wait a moment.',
  UNAUTHORIZED: 'Sign-in required. Please log in and try again.',
  SERVICE_UNAVAILABLE: 'Service temporarily unavailable. Please try again shortly.',
  UPSTREAM_UNAVAILABLE: 'Our provider is temporarily unavailable. Please try again shortly.',
  UPSTREAM_ERROR: 'Our provider is having trouble. Please try again.',

  // Client-synth (set inside services/api-client.ts).
  TIMEOUT: 'The request took too long. Please try again.',
  NETWORK_ERROR: 'Network error. Please check your connection.',

  // Deliberately pass-through — backend `message` wins. VALIDATION_ERROR
  // carries Zod-rendered issues that are already tailored; IDEMPOTENCY_KEY
  // errors are developer-facing; NOT_FOUND should usually route to a 404
  // page rather than a toast.
  VALIDATION_ERROR: null,
  IDEMPOTENCY_KEY_REQUIRED: null,
  NOT_FOUND: null,
  INTERNAL_ERROR: null,
};

/**
 * Status-only fallback for errors that didn't carry a recognised
 * `code` (older handlers, plain-object errors from elsewhere). The
 * code map above is strictly richer — this only fires when the code
 * branch didn't match.
 */
const STATUS_MESSAGES: Record<number, string> = {
  429: 'Too many attempts. Please wait a moment.',
  502: 'Our provider is having trouble. Please try again.',
  503: 'Service temporarily unavailable. Please try again shortly.',
  504: 'Our provider timed out. Please try again.',
};

/** Returns a user-friendly error message, checking if the device is offline. */
export function friendlyError(err: unknown, fallback: string): string {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return 'You appear to be offline. Please check your connection and try again.';
  }
  if (err instanceof ApiException) {
    // A2-1153: prefer the code-keyed string over status. Codes are
    // always more specific — an INSUFFICIENT_CREDIT 400 wants
    // different copy than a VALIDATION_ERROR 400. `null` in the map
    // means "fall through to the backend's own message" (still more
    // specific than a status-family string).
    if (Object.prototype.hasOwnProperty.call(CODE_MESSAGES, err.code)) {
      const mapped = CODE_MESSAGES[err.code];
      if (mapped !== null && mapped !== undefined) return mapped;
      if (mapped === null && err.message.length > 0) return err.message;
    }
    const statusMsg = STATUS_MESSAGES[err.status];
    if (statusMsg !== undefined) return statusMsg;
  } else if (err && typeof err === 'object' && 'status' in err) {
    // Fallback for plain shape-matching (e.g. a thrown object from elsewhere).
    const status = (err as { status: number }).status;
    const mapped = STATUS_MESSAGES[status];
    if (mapped !== undefined) return mapped;
  }
  return fallback;
}
