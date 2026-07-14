/**
 * `useAdminStepUp` — admin-write mutation hook (ADR 028, A4-063).
 *
 * Wraps a destructive admin write so the step-up auth dance is
 * transparent to the form:
 *
 *   1. The form calls `runWithStepUp(() => applyCreditAdjustment(...))`.
 *   2. The hook tries the mutation. If the held step-up token is
 *      fresh, the request succeeds (or fails on its own merits).
 *   3. If the backend returns 401 STEP_UP_REQUIRED / STEP_UP_INVALID
 *      / STEP_UP_SUBJECT_MISMATCH, the hook flips `modalOpen=true`
 *      and waits. The form renders <StepUpModal /> when `modalOpen`.
 *   4. The modal mints a token via `POST /api/admin/step-up` and
 *      calls `onConfirm(token)`, which seeds the store and triggers
 *      the queued retry.
 *   5. Retry runs once. Subsequent failures bubble to the form's
 *      error state — the hook does not loop.
 *
 * Sibling to TanStack Query's `useMutation` — works alongside it
 * but doesn't replace it. The form still owns the mutation lifecycle
 * (loading state, success cache invalidation, error display); the
 * hook just intercepts the step-up failure mode.
 */
import { useCallback, useRef, useState } from 'react';
import { ApiException } from '@loop/shared';
import { useAdminStepUpStore, type PendingActionSummary } from '~/stores/admin-step-up.store';

export type { PendingActionSummary, PendingActionAmount } from '~/stores/admin-step-up.store';

// Codes that mean "re-authenticate for this write": the hook opens the
// modal, mints a FRESH scoped token, and retries once. SEC-02-stepup
// added PURPOSE_MISMATCH (token minted for a different class) and
// ALREADY_USED (token already spent — single-use) to the set, since both
// are recovered by minting a fresh, correctly-scoped token — the same
// re-prompt flow as an expired / missing token.
const STEP_UP_FAILURE_CODES = new Set([
  'STEP_UP_REQUIRED',
  'STEP_UP_INVALID',
  'STEP_UP_SUBJECT_MISMATCH',
  'STEP_UP_PURPOSE_MISMATCH',
  'STEP_UP_ALREADY_USED',
]);

interface UseAdminStepUpReturn {
  /** True when <StepUpModal /> should render. */
  modalOpen: boolean;
  /** Wire to `<StepUpModal onConfirm>`. Mints succeeded, retry the queued mutation. */
  handleStepUpConfirm: (token: string, expiresAt: string) => void;
  /** Wire to `<StepUpModal onCancel>`. Cancels the queued mutation with an aborted error. */
  handleStepUpCancel: () => void;
  /**
   * Wraps the supplied async mutation. If the inner call rejects with
   * a step-up failure code, the hook opens the modal and resolves
   * (or rejects) once the modal flow completes. `action` (P2-07) is a
   * human-readable summary of what the OTP authorizes — amount /
   * destination / action type — echoed in the modal so the operator
   * sees what they approve. Pass it at initiation, where the payload
   * is still in scope (before the caller nulls its own pending state).
   */
  runWithStepUp: <T>(fn: () => Promise<T>, action?: PendingActionSummary) => Promise<T>;
}

export function useAdminStepUp(): UseAdminStepUpReturn {
  const setStepUp = useAdminStepUpStore((s) => s.setStepUp);
  const clearStepUp = useAdminStepUpStore((s) => s.clear);
  const setPendingAction = useAdminStepUpStore((s) => s.setPendingAction);

  // P2-06: the queue of step-up-blocked mutations awaiting a single
  // token mint. Held in a ref, not React state, because two concurrent
  // `runWithStepUp` calls each append synchronously — a `useState`
  // single slot (or even a functional-update array) invited a lost
  // update where the second call's `set` overwrote the first, silently
  // dropping one mutation's promise (it never resolved or rejected). A
  // ref append is atomic and never loses an entry, and the modal already
  // gates on `modalOpen` so no re-render is needed to hold the queue.
  const [modalOpen, setModalOpen] = useState(false);
  const pendingQueueRef = useRef<
    Array<{
      fn: () => Promise<unknown>;
      resolve: (value: unknown) => void;
      reject: (err: unknown) => void;
    }>
  >([]);

  const handleStepUpConfirm = useCallback(
    (token: string, expiresAt: string) => {
      setStepUp(token, expiresAt);
      setModalOpen(false);
      setPendingAction(null);
      // P2-06: drain the WHOLE queue so every concurrent step-up demand
      // is served — no loser is left with a promise that never settles.
      // Each queued mutation is replayed and captures the freshly-minted
      // token synchronously at dispatch (`authenticatedRequest` reads it
      // from the store when it builds the request).
      const queued = pendingQueueRef.current;
      pendingQueueRef.current = [];
      for (const pending of queued) {
        pending
          .fn()
          .then(pending.resolve)
          .catch(pending.reject)
          .finally(() => {
            // SEC-02-stepup: step-up tokens are now SINGLE-USE and
            // class-bound, so this token authorizes exactly one write.
            // Burn it once the write settles so the next protected write
            // mints a fresh, correctly-scoped token (re-mint-per-row /
            // least-privilege) instead of replaying a now-dead one. A
            // concurrent sibling the single-use server rejects settles via
            // its own reject path (STEP_UP_ALREADY_USED) — never a hang.
            clearStepUp();
          });
      }
    },
    [setStepUp, setPendingAction, clearStepUp],
  );

  const handleStepUpCancel = useCallback(() => {
    setModalOpen(false);
    setPendingAction(null);
    // Cancel rejects EVERY queued mutation deterministically — no
    // concurrent demand is left hanging with an unresolved promise.
    const queued = pendingQueueRef.current;
    pendingQueueRef.current = [];
    for (const pending of queued) {
      pending.reject(new Error('Admin step-up cancelled'));
    }
  }, [setPendingAction]);

  const runWithStepUp = useCallback(
    <T>(fn: () => Promise<T>, action?: PendingActionSummary): Promise<T> => {
      return fn().catch((err: unknown) => {
        if (
          err instanceof ApiException &&
          err.status === 401 &&
          STEP_UP_FAILURE_CODES.has(err.code)
        ) {
          // Stale / mismatched token — clear before prompting so the
          // next mutation doesn't re-send the bad value.
          clearStepUp();
          return new Promise<T>((resolve, reject) => {
            pendingQueueRef.current.push({
              fn: fn as () => Promise<unknown>,
              resolve: resolve as (value: unknown) => void,
              reject,
            });
            // P2-07: record what the OTP authorizes so StepUpModal can
            // echo it. `clearStepUp()` above already reset it to null,
            // so an un-summarised caller shows no (stale) action.
            if (action !== undefined) setPendingAction(action);
            setModalOpen(true);
          });
        }
        throw err;
      });
    },
    [clearStepUp, setPendingAction],
  );

  return { modalOpen, handleStepUpConfirm, handleStepUpCancel, runWithStepUp };
}
