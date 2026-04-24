/**
 * A2-1163: admin-write envelopes carry `audit.replayed: true` when
 * the backend matched an Idempotency-Key against a stored snapshot
 * and returned the prior response instead of running the handler
 * fresh (ADR 017).
 *
 * Previously this signal reached the UI (via the `AdminWriteEnvelope`
 * shape) but no operator-facing surface rendered it. An operator
 * who double-clicked `Apply` saw a success confirmation identical
 * to a fresh write — with no visible clue that the second request
 * replayed the first and ignored the new `reason` field.
 *
 * This component is the one-line fix: render a small inline badge
 * next to the success message when `replayed === true`. Keeping the
 * badge DOM-local + colour-neutral (amber, not red/green) so it
 * reads as "heads up" rather than "error".
 */
import type React from 'react';

export function ReplayedBadge({ replayed }: { replayed: boolean }): React.JSX.Element | null {
  if (!replayed) return null;
  return (
    <span
      role="note"
      aria-label="Replayed from idempotency snapshot"
      title="This Idempotency-Key matched a prior request. The backend returned the stored snapshot; your new reason/body was NOT re-applied (ADR 017 §5)."
      className="ml-2 inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
    >
      Replayed
    </span>
  );
}
