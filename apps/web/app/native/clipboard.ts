import { Capacitor } from '@capacitor/core';
import { triggerHapticNotification } from './haptics';

/** Copies text to clipboard. Returns true on success. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { Clipboard } = await import('@capacitor/clipboard');
      await Clipboard.write({ string: text });
    } else {
      await navigator.clipboard.writeText(text);
    }
    void triggerHapticNotification('success');
    return true;
  } catch {
    return false;
  }
}
