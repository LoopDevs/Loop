/**
 * Client-side email shape check for auth entry (onboarding).
 *
 * Consolidates the hand-rolled `/.+@.+\..+/` regex that had been
 * copy-pasted into `Onboarding.tsx` and `signup-tail.tsx` (code-health
 * finding FE-57). That inline pattern was unanchored and permissive:
 * it green-lit whitespace (`"a b@x.com"`), a second `@`
 * (`"foo@bar@baz.com"`), and leading/trailing junk — all of which the
 * backend rejects, so the client would show a "looks ok" affordance for
 * addresses the server then refuses.
 *
 * The rule here mirrors the backend's own email-shape regex
 * (`EMAIL_SHAPE` in `apps/backend/src/admin/user-by-email.ts`):
 * anchored, no whitespace, exactly one `@`, and a dot in the domain.
 * It's a plausible-shape gate, not a full RFC 5321 validator — the
 * authoritative check remains the server's `z.string().email()` on
 * `POST /api/auth/request-otp`. Keeping the client rule aligned with the
 * backend means the two agree on the shapes that matter instead of
 * drifting apart in two copies.
 */

// Mirror of the backend's EMAIL_SHAPE (apps/backend/src/admin/user-by-email.ts).
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * `true` when `email` has a plausible address shape (matches the
 * backend's `EMAIL_SHAPE`). Used to gate the onboarding email field's
 * "valid" affordance and CTA; the server does the authoritative check.
 */
export function isValidEmail(email: string): boolean {
  return EMAIL_SHAPE.test(email);
}
