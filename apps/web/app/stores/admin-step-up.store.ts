/**
 * Admin step-up token store (ADR 028, A4-063).
 *
 * Holds the short-lived (5-minute) `X-Admin-Step-Up` JWT minted by
 * `POST /api/admin/step-up` after the admin re-presents an OTP.
 * Memory-only by design — never persist to localStorage / Capacitor
 * preferences. The 5-minute TTL is enforced by the JWT's `exp`
 * claim; this store mirrors `expiresAt` so the UI can pre-emptively
 * clear an expired token without a round-trip.
 *
 * Sibling to `auth.store` — kept separate because the lifecycle
 * differs: auth tokens persist across reloads via the refresh-token
 * path; step-up tokens are deliberately session-bounded so a stale
 * tab can't carry a step-up across an admin's "I'm leaving for
 * lunch" window.
 */
import { create } from 'zustand';

interface AdminStepUpState {
  /** The active step-up JWT, or null if none / expired. */
  token: string | null;
  /** Unix-ms when the token expires (mirrors the JWT `exp` claim × 1000). */
  expiresAtMs: number | null;
  /** Set after a successful POST /api/admin/step-up. */
  setStepUp: (token: string, expiresAtIso: string) => void;
  /**
   * Clear the token. Called explicitly on admin logout, on
   * STEP_UP_INVALID / STEP_UP_SUBJECT_MISMATCH responses, and when
   * the UI detects an already-expired token before the next call.
   */
  clear: () => void;
  /** True iff a non-expired token is currently held. */
  isFresh: () => boolean;
}

export const useAdminStepUpStore = create<AdminStepUpState>((set, get) => ({
  token: null,
  expiresAtMs: null,
  setStepUp: (token, expiresAtIso) => set({ token, expiresAtMs: new Date(expiresAtIso).getTime() }),
  clear: () => set({ token: null, expiresAtMs: null }),
  isFresh: () => {
    const { token, expiresAtMs } = get();
    if (token === null || expiresAtMs === null) return false;
    // Subtract a 5-second skew so a token that's about to expire
    // doesn't squeak through and 401 mid-flight. The backend
    // tolerates token age via the `exp` claim — being conservative
    // on the client avoids a wasted round-trip.
    return expiresAtMs - 5_000 > Date.now();
  },
}));
