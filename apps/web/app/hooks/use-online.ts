import { useState, useEffect } from 'react';
import { watchNetwork } from '~/native/network';

/**
 * Tracks device connectivity. Returns `true` while the device is online and
 * `false` once it loses its network connection.
 *
 * SSR-safe: reports `true` on the first (server) render, then syncs to the
 * real status on mount via `watchNetwork` — `navigator.onLine` plus the
 * `online`/`offline` events on web, and the Capacitor `Network` plugin on
 * native. It stays subscribed for the component's lifetime and cleans up on
 * unmount.
 *
 * Use it to gate network-dependent actions — e.g. disabling a money-action
 * button while offline so a tap can't fire a request that will only fail and
 * tempt the user into a confused re-tap.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    return watchNetwork(setOnline);
  }, []);

  return online;
}
