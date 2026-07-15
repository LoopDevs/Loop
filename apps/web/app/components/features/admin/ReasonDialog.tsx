import { useId, useRef, useState } from 'react';
import { Button } from '~/components/ui/Button';
import { Dialog } from '~/components/ui/Dialog';

/**
 * A2-1107: a11y-friendly replacement for `window.prompt` on admin
 * write forms. FE-33: the native `<dialog>` shell (focus trap, ESC
 * dismissal, aria-modal) lives in the shared `Dialog` primitive; this
 * component owns the reason textarea + validation.
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
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const helperId = useId();

  // Reset the field + error on each reopen. `Dialog` calls this on the
  // closed→open transition, before it focuses the textarea — the same
  // order the pre-refactor effect used.
  const resetOnOpen = (): void => {
    setValue('');
    setError(null);
  };

  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length < MIN_LEN || trimmed.length > MAX_LEN) {
      setError(`Reason must be ${MIN_LEN}–${MAX_LEN} characters`);
      // Return focus to the field the admin must fix; the submit click
      // otherwise strands focus on the Confirm button.
      inputRef.current?.focus();
      return;
    }
    onResolve(trimmed);
  };

  const cancel = (): void => {
    onResolve(null);
  };

  return (
    <Dialog
      open={open}
      onClose={cancel}
      onOpen={resetOnOpen}
      initialFocusRef={inputRef}
      labelledBy={`${helperId}-title`}
      describedBy={description !== undefined ? `${helperId}-desc` : undefined}
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
          <span
            id={error !== null ? `${helperId}-error` : undefined}
            // Persistent assertive live region: it always occupies the
            // layout (holding a non-breaking space when clear), so when the
            // validation message is injected here AT announces it. The bare
            // <span> made the error visible but silent to screen readers.
            role="alert"
            className="text-red-600"
          >
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
    </Dialog>
  );
}
