import { Capacitor } from '@capacitor/core';

export type Platform = 'ios' | 'android' | 'web';

/** Returns the current platform identifier. */
export function getPlatform(): Platform {
  return Capacitor.getPlatform() as Platform;
}

/** Returns true when running inside a native Capacitor shell. */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}
