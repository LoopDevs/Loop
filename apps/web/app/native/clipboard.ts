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

/**
 * Reads a plain-text clipboard payload, preferring the Capacitor
 * plugin on native (the browser `navigator.clipboard.readText` is
 * often blocked inside the Android WebView without a prior user
 * gesture or explicit read-permission) and falling back to the web
 * API otherwise. Returns `null` when nothing is available or the
 * read fails — callers should treat that as "no clipboard", not
 * an error.
 */
export async function readClipboard(): Promise<string | null> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { Clipboard } = await import('@capacitor/clipboard');
      const { value } = await Clipboard.read();
      return typeof value === 'string' && value.length > 0 ? value : null;
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      const value = await navigator.clipboard.readText();
      return value.length > 0 ? value : null;
    }
    return null;
  } catch {
    return null;
  }
}
