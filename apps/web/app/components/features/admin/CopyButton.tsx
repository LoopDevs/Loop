import { useEffect, useState } from 'react';

const COPIED_FLASH_MS = 1500;

interface Props {
  /** Value to copy to the clipboard. */
  text: string;
  /** ARIA label for screen readers (e.g. "Copy user id"). */
  label: string;
}

/**
 * Tiny copy-to-clipboard icon button for admin surfaces. Ops paste
 * ids (order, user, payout) into tickets constantly; a one-click
 * copy saves a highlight-triple-click every time.
 *
 * Shows a brief "Copied" flash after success, reverts after 1.5s.
 *
 * A2-1158: clipboard fallback chain — the Async Clipboard API
 * (`navigator.clipboard.writeText`) throws on:
 *   - non-secure origins (HTTP pages that aren't localhost)
 *   - older Safari that hasn't shipped the API
 *   - browsers with clipboard-permission denied
 *
 * Previously the bare `await writeText` path silently no-op'd in
 * those cases; ops on an HTTP staging host or an older Safari
 * would click and get nothing. Fall through to the deprecated-
 * but-universal `document.execCommand('copy')` via a hidden
 * textarea — deprecated since 2018, still implemented by every
 * browser, and the only way to programmatically copy on an
 * insecure origin. Final fallback is a silent no-op (same as
 * before); the value is still visible next to the button so the
 * user can manually select + Ctrl-C.
 */
async function tryClipboardCopy(text: string): Promise<boolean> {
  // Prefer the modern async API when available and allowed.
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through — permission denied, insecure context, or
      // browser quirk. Try the execCommand path below.
    }
  }
  // Fallback: hidden textarea + document.execCommand('copy').
  // Works on insecure origins + older Safari + anywhere the
  // Clipboard API hasn't landed. Guarded for SSR — `document`
  // doesn't exist server-side, and this function is only ever
  // called from a click handler so we shouldn't reach here at
  // import time, but belt-and-braces.
  if (typeof document === 'undefined') return false;
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    // Hide off-screen so the page doesn't visibly twitch during
    // the focus/select round-trip; readonly + aria-hidden keep
    // it out of the tab order + screen-reader output.
    textarea.setAttribute('readonly', '');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/**
 * `label` is always phrased "Copy <noun>" (the convention every call site
 * in this codebase follows — "Copy order id", "Copy USDLOOP issuer", etc).
 * Strip that verb prefix and capitalise so the aria-live announcement reads
 * as a natural sentence — "Order id copied to clipboard." — matching the
 * "<field> copied to clipboard." phrasing PaymentStep / LoopPaymentStep's
 * Row already use.
 */
function announceSubject(label: string): string {
  const stripped = label.replace(/^copy\s+/i, '');
  return stripped.length > 0 ? stripped[0]!.toUpperCase() + stripped.slice(1) : stripped;
}

export function CopyButton({ text, label }: Props): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    return () => clearTimeout(t);
  }, [copied]);

  const handleClick = async (): Promise<void> => {
    const ok = await tryClipboardCopy(text);
    if (ok) setCopied(true);
    // Final failure is silent — the value is still visible next
    // to the button so the user can select it manually. Matches
    // prior behaviour for the Clipboard-API-denied path.
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void handleClick()}
        aria-label={label}
        className="inline-flex items-center gap-1 rounded border border-transparent px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
      >
        {copied ? (
          <>
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-3 w-3 text-green-600 dark:text-green-400"
            >
              <path
                fillRule="evenodd"
                d="M16.704 5.29a.75.75 0 0 1 .006 1.06l-7.5 7.56a.75.75 0 0 1-1.07.004l-3.75-3.76a.75.75 0 1 1 1.064-1.058l3.217 3.226 6.968-7.026a.75.75 0 0 1 1.065-.006Z"
                clipRule="evenodd"
              />
            </svg>
            Copied
          </>
        ) : (
          <>
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              className="h-3 w-3"
            >
              <rect x="5" y="5" width="11" height="11" rx="1.5" />
              <rect x="3" y="3" width="11" height="11" rx="1.5" />
            </svg>
            Copy
          </>
        )}
      </button>
      {/* WUM-10 (2026-06-30 cold audit) / CF-35 rollout: confirm copy to
          assistive tech. Highest-stakes site in the rollout — this button
          backs TrustlineSetupCard's LOOP-asset issuer-pubkey copy, and the
          click handler above is silent-by-design on failure, so this is
          the only success signal a screen-reader user gets. */}
      <span aria-live="polite" className="sr-only">
        {copied ? `${announceSubject(label)} copied to clipboard.` : ''}
      </span>
    </>
  );
}
