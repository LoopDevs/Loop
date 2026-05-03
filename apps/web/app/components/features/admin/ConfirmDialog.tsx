import { useEffect, useId, useRef } from 'react';
import { Button } from '~/components/ui/Button';

/**
 * A4-052 / A4-053: second-step confirmation gate for destructive
 * admin write actions where the reason is already collected
 * inline in the parent form (CreditAdjustmentForm,
 * AdminWithdrawalForm). Sibling to ReasonDialog — that one prompts
 * for the reason itself; this one just renders the parsed summary
 * and asks "are you sure?".
 *
 * Native HTML <dialog> handles focus trap, ESC dismissal, and
 * aria-modal=true for free.
 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /**
   * Body content. Caller renders the action summary so the operator
   * can spot a fat-finger before the mutation fires.
   */
  body: React.ReactNode;
  confirmLabel?: string;
  /**
   * Visual treatment for the confirm button. `danger` for
   * destructive writes (default), `primary` for routine confirms.
   */
  confirmVariant?: 'destructive' | 'primary';
  onResolve: (confirmed: boolean) => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  confirmVariant = 'destructive',
  onResolve,
}: ConfirmDialogProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const helperId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      requestAnimationFrame(() => cancelButtonRef.current?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const cancel = (): void => onResolve(false);
  const confirm = (): void => onResolve(true);

  const handleClose = (): void => {
    if (open) onResolve(false);
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={handleClose}
      onCancel={(e) => {
        e.preventDefault();
        cancel();
      }}
      className="rounded-lg shadow-xl backdrop:bg-black/60 p-0 max-w-md w-[90vw] bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
      aria-labelledby={`${helperId}-title`}
      aria-describedby={`${helperId}-desc`}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
        className="flex flex-col gap-3 p-5"
      >
        <h2 id={`${helperId}-title`} className="text-base font-semibold">
          {title}
        </h2>
        <div id={`${helperId}-desc`} className="text-sm text-gray-700 dark:text-gray-300">
          {body}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button ref={cancelButtonRef} type="button" variant="secondary" onClick={cancel}>
            Cancel
          </Button>
          <Button type="submit" variant={confirmVariant}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
