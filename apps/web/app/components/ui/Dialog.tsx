import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

/**
 * FE-33: shared modal-dialog primitive.
 *
 * Several admin/app surfaces (`ConfirmDialog`, `ReasonDialog`,
 * `SessionExpiredPrompt`, the refund dialog inside `RefundOrderPanel`)
 * had each hand-rolled the *same* native `<dialog>` shell byte-for-byte:
 * the `open`-driven `showModal()`/`close()` effect, the `onCancel`
 * preventDefault + `onClose` guard, the identical scrim/rounding classes,
 * and the `requestAnimationFrame` initial-focus idiom. That duplication is
 * a drift surface — a fix to the focus/ESC behaviour in one never reached
 * the others. This extracts the shell once; callers render only their body.
 *
 * Behaviour is deliberately identical to the extracted call sites — this
 * is a refactor, not a UX change:
 *   - Native `<dialog>` + `showModal()` provides the focus trap,
 *     `aria-modal=true`, and top-layer scrim for free.
 *   - `open` is controlled by the parent; the effect opens/closes the
 *     dialog to match and (via `initialFocusRef`) moves focus in on open.
 *   - Esc fires `cancel`; we `preventDefault()` it (so React state stays
 *     the source of truth for open/closed) and call `onClose`. The native
 *     `close` event also calls `onClose`, guarded by `open` so the
 *     programmatic `close()` we trigger ourselves doesn't double-fire it.
 */
export interface DialogProps {
  /** Whether the dialog is open. The parent owns this state. */
  open: boolean;
  /**
   * Called when the dialog is dismissed WITHOUT an explicit action — Esc,
   * or any native `close` fired while still open. Callers map this to
   * their cancel semantics (`onResolve(false | null)`, `setOpen(false)`…).
   */
  onClose: () => void;
  /** id of the element that labels the dialog (`aria-labelledby`). */
  labelledBy: string;
  /** id of the element that describes the dialog (`aria-describedby`). Omit if none. */
  describedBy?: string | undefined;
  /**
   * Focused after the dialog opens (via rAF, once `showModal()` has
   * committed). Without it the browser focuses the first focusable child.
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Called on the closed→open transition, before focus moves in — callers
   * use it to reset body state (clear inputs / errors) on each reopen, so
   * the reset lands before the panel paints (matches the pre-refactor
   * order where the reset ran in the same effect just before `showModal`).
   */
  onOpen?: () => void;
  /** Panel max-width. `lg` for denser dialogs (refund); `md` otherwise. */
  size?: 'md' | 'lg';
  /** The dialog body — a `<form method="dialog">` or a plain container. */
  children: ReactNode;
}

// Shared shell: rounding, shadow, scrim, dark-mode surface + text. Kept
// verbatim from the extracted call sites so the migration is visual-parity.
const SHELL_CLASSES =
  'rounded-lg shadow-xl backdrop:bg-black/60 p-0 w-[90vw] bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100';

const SIZE_CLASSES: Record<NonNullable<DialogProps['size']>, string> = {
  md: 'max-w-md',
  lg: 'max-w-lg',
};

export function Dialog({
  open,
  onClose,
  labelledBy,
  describedBy,
  initialFocusRef,
  onOpen,
  size = 'md',
  children,
}: DialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      onOpen?.();
      dialog.showModal();
      requestAnimationFrame(() => initialFocusRef?.current?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
    }
    // Keyed on `open` only — matches the extracted call sites, whose
    // effects re-ran solely on the open transition. `onOpen` /
    // `initialFocusRef` are stable across the renders that matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      onClose={() => {
        // Guard against the self-triggered close() above re-firing onClose
        // (by then `open` is already false).
        if (open) onClose();
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={`${SHELL_CLASSES} ${SIZE_CLASSES[size]}`}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
    >
      {children}
    </dialog>
  );
}
