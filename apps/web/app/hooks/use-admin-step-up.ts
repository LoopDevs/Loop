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
import { useCallback, useState } from 'react';
import { ApiException } from '@loop/shared';
import { useAdminStepUpStore } from '~/stores/admin-step-up.store';

const STEP_UP_FAILURE_CODES = new Set([
  'STEP_UP_REQUIRED',
  'STEP_UP_INVALID',
  'STEP_UP_SUBJECT_MISMATCH',
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
   * (or rejects) once the modal flow completes.
   */
  runWithStepUp: <T>(fn: () => Promise<T>) => Promise<T>;
}

export function useAdminStepUp(): UseAdminStepUpReturn {
  const setStepUp = useAdminStepUpStore((s) => s.setStepUp);
  const clearStepUp = useAdminStepUpStore((s) => s.clear);

  // Pending state for the queued mutation. Pulling these into refs
  // would avoid re-renders, but the modal itself already gates
  // on `modalOpen`, so the extra render-pass is not load-bearing.
  const [modalOpen, setModalOpen] = useState(false);
  const [pendingResolve, setPendingResolve] = useState<{
    fn: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (err: unknown) => void;
  } | null>(null);

  const handleStepUpConfirm = useCallback(
    (token: string, expiresAt: string) => {
      setStepUp(token, expiresAt);
      setModalOpen(false);
      const pending = pendingResolve;
      setPendingResolve(null);
      if (pending !== null) {
        // Re-run the mutation now that the store has a fresh token.
        // `authenticatedRequest` reads it from the store on the next
        // call. Errors here surface to the original caller via the
        // pending promise's reject path.
        pending.fn().then(pending.resolve).catch(pending.reject);
      }
    },
    [setStepUp, pendingResolve],
  );

  const handleStepUpCancel = useCallback(() => {
    setModalOpen(false);
    const pending = pendingResolve;
    setPendingResolve(null);
    if (pending !== null) {
      pending.reject(new Error('Admin step-up cancelled'));
    }
  }, [pendingResolve]);

  const runWithStepUp = useCallback(
    <T>(fn: () => Promise<T>): Promise<T> => {
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
            setPendingResolve({
              fn: fn as () => Promise<unknown>,
              resolve: resolve as (value: unknown) => void,
              reject,
            });
            setModalOpen(true);
          });
        }
        throw err;
      });
    },
    [clearStepUp],
  );

  return { modalOpen, handleStepUpConfirm, handleStepUpCancel, runWithStepUp };
}
