import { useOnline } from '~/hooks/use-online';

/** Shows a banner when the device is offline. Auto-hides when reconnected. */
export function OfflineBanner(): React.JSX.Element | null {
  // Single source of truth for connectivity — the same hook that gates
  // the money/network-action buttons (FE-43). Previously this inlined its
  // own `useState`/`watchNetwork` copy of the exact same logic.
  const online = useOnline();

  if (online) return null;

  return (
    <div
      role="alert"
      className="fixed left-0 right-0 z-[9999] bg-red-600 dark:bg-red-800 text-white text-center text-sm py-2 px-4"
      style={{ top: 'env(safe-area-inset-top)' }}
    >
      No internet connection
    </div>
  );
}
