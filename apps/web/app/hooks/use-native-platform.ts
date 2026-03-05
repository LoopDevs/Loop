import { useState, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';

export type Platform = 'ios' | 'android' | 'web';

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
      platform: Capacitor.getPlatform() as Platform,
      isNative: Capacitor.isNativePlatform(),
    });
  }, []);

  return state;
}
