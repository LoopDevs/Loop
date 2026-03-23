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
    <div className="fixed top-0 left-0 right-0 z-[9999] bg-red-600 text-white text-center text-sm py-2 px-4 native-safe-top">
      No internet connection
    </div>
  );
}
