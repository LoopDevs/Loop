import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { onSessionExpired } from '~/services/api-client';
import { Button } from '~/components/ui/Button';

/**
 * FE-40: centralized session-expiry re-auth prompt.
 *
 * When an authenticated request's session is definitively dead (a 401
 * whose one silent refresh also fails), `api-client` clears the auth
 * store and emits a session-expiry event (see `onSessionExpired`).
 * Before this, that path surfaced a generic "something went wrong"
 * error at each call site — a user whose session lapsed mid-purchase
 * saw an opaque failure, retried into more 401s, and could lose their
 * in-progress action.
 *
 * This component subscribes to the event once, app-wide (mounted in the
 * root shell next to `ToastContainer`), and renders a clear "your
 * session expired — sign in again" prompt that routes to the sign-in
 * surface. The prompt lives in the app layer on purpose: the transport
 * stays UI-free and only calls injected listeners. Admin step-up
 * challenges are exempted at the emit site, so this prompt never
 * hijacks the step-up flow.
 *
 * Native <dialog> gives us the focus trap, ESC dismissal, and
 * aria-modal semantics for free (same pattern as ConfirmDialog /
 * StepUpModal).
 */
export function SessionExpiredPrompt(): React.JSX.Element {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const signInButtonRef = useRef<HTMLButtonElement | null>(null);

  // Subscribe once for the component's lifetime. `onSessionExpired`
  // returns an unsubscribe fn so a re-mount can't stack listeners.
  useEffect(() => {
    return onSessionExpired(() => {
      // Coalesce a burst of parallel 401s into a single prompt — flip
      // to open; if already open, this is a no-op.
      setOpen(true);
    });
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      requestAnimationFrame(() => signInButtonRef.current?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const dismiss = (): void => setOpen(false);

  const signIn = (): void => {
    setOpen(false);
    // The authed app is single-locale (see routes.ts) — `/auth` is the
    // canonical sign-in surface, matching every other in-app sign-in
    // link/redirect.
    void navigate('/auth');
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={dismiss}
      onCancel={(e) => {
        e.preventDefault();
        dismiss();
      }}
      className="rounded-lg shadow-xl backdrop:bg-black/60 p-0 max-w-md w-[90vw] bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
      aria-labelledby="session-expired-title"
      aria-describedby="session-expired-desc"
    >
      <div className="flex flex-col gap-3 p-5">
        <h2 id="session-expired-title" className="text-base font-semibold">
          Your session expired
        </h2>
        <p id="session-expired-desc" className="text-sm text-gray-700 dark:text-gray-300">
          For your security you&rsquo;ve been signed out. Please sign in again to pick up where you
          left off.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={dismiss}>
            Not now
          </Button>
          <Button ref={signInButtonRef} type="button" variant="primary" onClick={signIn}>
            Sign in again
          </Button>
        </div>
      </div>
    </dialog>
  );
}
