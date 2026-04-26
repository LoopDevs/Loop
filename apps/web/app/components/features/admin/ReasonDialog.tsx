import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '~/components/ui/Button';

/**
 * A2-1107: a11y-friendly replacement for `window.prompt` on admin
 * write forms. Rendered as a native HTML `<dialog>` element so the
 * browser handles focus trap, ESC dismissal, and `aria-modal=true`
 * for free — no extra deps and no manual focus management.
 *
 * The 2-500 character validation matches the existing window.prompt
 * sites (ADR-017 reason length contract); enforcement lives here so
 * every consumer gets it without re-implementing.
 */
export interface ReasonDialogProps {
  /** Whether the dialog is open. Caller controls open/close lifecycle. */
  open: boolean;
  /** Title prompt — e.g. "Reason for retrying this payout?". */
  title: string;
  /** Optional helper text rendered under the title. */
  description?: string;
  /** Submit-button label. Defaults to "Confirm". */
  confirmLabel?: string;
  /**
   * Resolved with the trimmed reason on submit, or `null` on cancel /
   * ESC. Caller is responsible for closing the dialog after handling
   * the value.
   */
  onResolve: (reason: string | null) => void;
}

const MIN_LEN = 2;
const MAX_LEN = 500;

export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  onResolve,
}: ReasonDialogProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const helperId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      setValue('');
      setError(null);
      dialog.showModal();
      // Focus the textarea after the dialog opens — the browser
      // would otherwise focus the first focusable child, which is
      // the close button.
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length < MIN_LEN || trimmed.length > MAX_LEN) {
      setError(`Reason must be ${MIN_LEN}–${MAX_LEN} characters`);
      return;
    }
    onResolve(trimmed);
  };

  const cancel = (): void => {
    onResolve(null);
  };

  // The native dialog's `close` event fires for ESC + form-submit
  // method="dialog" + dialog.close(). Map ESC → cancel (we handle
  // submit explicitly via the button click).
  const handleClose = (): void => {
    if (open) onResolve(null);
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
      aria-describedby={description !== undefined ? `${helperId}-desc` : undefined}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3 p-5"
      >
        <h2 id={`${helperId}-title`} className="text-base font-semibold">
          {title}
        </h2>
        {description !== undefined && (
          <p id={`${helperId}-desc`} className="text-sm text-gray-600 dark:text-gray-400">
            {description}
          </p>
        )}
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error !== null) setError(null);
          }}
          minLength={MIN_LEN}
          maxLength={MAX_LEN}
          rows={3}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? `${helperId}-error` : undefined}
          className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
          <span id={error !== null ? `${helperId}-error` : undefined} className="text-red-600">
            {error ?? '\u00a0'}
          </span>
          <span>
            {value.trim().length}/{MAX_LEN}
          </span>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={cancel}>
            Cancel
          </Button>
          <Button type="submit">{confirmLabel}</Button>
        </div>
      </form>
    </dialog>
  );
}
