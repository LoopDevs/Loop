import { useState, useEffect } from 'react';
import { watchNetwork } from '~/native/network';

/** Shows a banner when the device is offline. Auto-hides when reconnected. */
export function OfflineBanner(): React.JSX.Element | null {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    return watchNetwork(setOnline);
  }, []);

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
