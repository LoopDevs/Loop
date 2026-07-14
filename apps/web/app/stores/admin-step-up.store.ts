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

/**
 * SEC-02-stepup: the action-class a step-up token is bound to. Mirrors
 * the backend `STEP_UP_SCOPES` union (auth/admin-step-up.ts) MINUS the
 * `'admin-write'` wildcard — the client never mints a wildcard token,
 * because the gate rejects it. Each protected admin write requests a
 * token scoped to exactly the class its endpoint guards; the backend
 * validates the value (`z.enum(STEP_UP_SCOPES)`), so a drift from this
 * list surfaces as a 400 at mint time. Keep in sync with the backend.
 */
export type AdminStepUpScope =
  | 'credit-adjustment'
  | 'refund'
  | 'withdrawal'
  | 'emission'
  | 'payout-retry'
  | 'payout-compensation'
  | 'home-currency'
  | 'operator-float'
  | 'staff-role-grant'
  | 'staff-role-revoke'
  | 'cashback-config'
  | 'deposit-refund'
  | 'order-redrive'
  | 'order-refund'
  | 'vault-redrive';

/**
 * Money amount to echo in the step-up modal (P2-07). A structured
 * fiat-minor pair is formatted with the canonical `formatMinorCurrency`
 * in the modal; Stellar payouts (7-decimal stroops, a different
 * formatter — `fmtStroops`) pass an already-`formatted` string.
 */
export type PendingActionAmount =
  | { minor: bigint | string | number; currency: string }
  | { formatted: string };

/**
 * Human-readable summary of the destructive action an admin step-up
 * OTP authorizes. Held here — set at step-up INITIATION and read by
 * `StepUpModal` — so it survives the caller nulling its own local
 * pending-payload at the confirm-dialog step, and so the operator SEES
 * what the code approves rather than blind-authorizing an unseen
 * (irreversible) money movement. See P2-07.
 */
export interface PendingActionSummary {
  /** What is being authorized, e.g. "Queue emission" / "Retry payout". */
  action: string;
  /**
   * SEC-02-stepup: the action-CLASS this step-up mints a token for. The
   * modal threads it to `mintAdminStepUp(otp, scope)` so the minted
   * token is bound to exactly the write it authorizes (no wildcard) —
   * the gate rejects a token minted for a different class. Distinct from
   * `action`, which is the human-readable label.
   */
  scope: AdminStepUpScope;
  /** Optional money amount to echo (fiat-minor pair or pre-formatted). */
  amount?: PendingActionAmount;
  /** Optional destination / recipient (Stellar address, user id, …), shown verbatim. */
  destination?: string;
}

interface AdminStepUpState {
  /** The active step-up JWT, or null if none / expired. */
  token: string | null;
  /** Unix-ms when the token expires (mirrors the JWT `exp` claim × 1000). */
  expiresAtMs: number | null;
  /**
   * The action the currently-open step-up modal authorizes, or null.
   * Set when the step-up flow opens the modal; cleared when it
   * resolves / cancels (see `useAdminStepUp`).
   */
  pendingAction: PendingActionSummary | null;
  /** Set after a successful POST /api/admin/step-up. */
  setStepUp: (token: string, expiresAtIso: string) => void;
  /** Set/clear the summary echoed by the open step-up modal (P2-07). */
  setPendingAction: (action: PendingActionSummary | null) => void;
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
  pendingAction: null,
  setStepUp: (token, expiresAtIso) => set({ token, expiresAtMs: new Date(expiresAtIso).getTime() }),
  setPendingAction: (pendingAction) => set({ pendingAction }),
  clear: () => set({ token: null, expiresAtMs: null, pendingAction: null }),
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
