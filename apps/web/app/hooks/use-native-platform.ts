import { useState, useEffect } from 'react';
import type { Platform } from '~/native/platform';
import { getPlatform, isNativePlatform } from '~/native/platform';

export type { Platform };

export interface NativePlatform {
  platform: Platform;
  isNative: boolean;
}

/**
 * Returns the current platform and whether the app is running inside a native
 * Capacitor shell. Always returns `web` on first render (SSR-safe).
 */
export function useNativePlatform(): NativePlatform {
  const [state, setState] = useState<NativePlatform>({ platform: 'web', isNative: false });

  useEffect(() => {
    setState({
      platform: getPlatform(),
      isNative: isNativePlatform(),
    });
  }, []);

  return state;
}
