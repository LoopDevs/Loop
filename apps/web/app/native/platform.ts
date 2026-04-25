import { Capacitor } from '@capacitor/core';
// A2-800: re-export the shared `Platform` so the auth client (which
// also imports `Platform` from `@loop/shared` for the `clientId`
// mapping) and this native wrapper agree on one definition. Without
// this, a future fourth platform (e.g. desktop) added to shared
// would silently widen the API but stay rejected by `getPlatform()`.
import type { Platform } from '@loop/shared';

export type { Platform };

/** Returns the current platform identifier. */
export function getPlatform(): Platform {
  return Capacitor.getPlatform() as Platform;
}

/** Returns true when running inside a native Capacitor shell. */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}
