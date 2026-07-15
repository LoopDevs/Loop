import { useId, useRef } from 'react';
import { Button } from '~/components/ui/Button';
import { Dialog } from '~/components/ui/Dialog';

/**
 * A4-052 / A4-053: second-step confirmation gate for destructive
 * admin write actions where the reason is already collected
 * inline in the parent form (CreditAdjustmentForm,
 * AdminEmissionForm). Sibling to ReasonDialog — that one prompts
 * for the reason itself; this one just renders the parsed summary
 * and asks "are you sure?".
 *
 * FE-33: the native `<dialog>` shell (focus trap, ESC dismissal,
 * aria-modal, scrim) lives in the shared `Dialog` primitive; this
 * component supplies only the confirm/cancel body.
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
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const helperId = useId();

  const cancel = (): void => onResolve(false);
  const confirm = (): void => onResolve(true);

  return (
    <Dialog
      open={open}
      onClose={cancel}
      initialFocusRef={cancelButtonRef}
      labelledBy={`${helperId}-title`}
      describedBy={`${helperId}-desc`}
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
    </Dialog>
  );
}
