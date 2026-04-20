import { useState } from 'react';

interface FixedSearchButtonProps {
  value: string;
  onChange: (value: string) => void;
}

/**
 * Fixed top-left search control. Collapsed to a circular icon button
 * until tapped; then expands inline into a search input. Filter state
 * is lifted so the caller can apply it to its own data grid.
 *
 * Positioned below the status bar on native via safe-area padding; on
 * web the safe-area insets evaluate to 0 and the control sits at the
 * top edge of the viewport.
 */
export function FixedSearchButton({ value, onChange }: FixedSearchButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const handleClose = (): void => {
    setOpen(false);
    onChange('');
  };

  return (
    <div
      className="lg:hidden fixed top-0 left-0 z-[1200] p-3"
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
    >
      {open ? (
        <div className="flex items-center gap-2 bg-white/95 dark:bg-gray-900/95 rounded-full shadow-lg backdrop-blur-md pl-3 pr-1 py-1 w-[min(85vw,22rem)]">
          <SearchIcon className="h-4 w-4 text-gray-500 dark:text-gray-400 flex-shrink-0" />
          <input
            type="search"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Search merchants"
            aria-label="Search merchants"
            className="flex-1 bg-transparent outline-none text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 py-1"
          />
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close search"
            className="h-7 w-7 rounded-full flex items-center justify-center text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Search merchants"
          className="h-10 w-10 rounded-full bg-white/90 dark:bg-gray-900/90 shadow-lg backdrop-blur-md flex items-center justify-center text-gray-700 dark:text-gray-300"
        >
          <SearchIcon className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}

function SearchIcon({ className = '' }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function XIcon({ className = '' }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
