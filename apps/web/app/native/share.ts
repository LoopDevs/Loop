import { Capacitor } from '@capacitor/core';

/** Opens the native share sheet. Falls back to Web Share API on web. */
export async function nativeShare(options: { title: string; text: string }): Promise<boolean> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { Share } = await import('@capacitor/share');
      await Share.share({ title: options.title, text: options.text });
      return true;
    }

    // Web fallback: use Web Share API if available
    if (navigator.share) {
      await navigator.share({ title: options.title, text: options.text });
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
