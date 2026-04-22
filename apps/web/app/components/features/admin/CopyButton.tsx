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
 * Falls back silently when clipboard access fails (denied, insecure
 * context) — the value is still visible next to the button so the
 * user can select it manually.
 */
export function CopyButton({ text, label }: Props): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    return () => clearTimeout(t);
  }, [copied]);

  const handleClick = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      /* clipboard unavailable — silent; user can still select text */
    }
  };

  return (
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
  );
}
