import { Capacitor } from '@capacitor/core';
import { triggerHapticNotification } from './haptics';

/**
 * Raw platform write. Prefers the Capacitor plugin on native and the
 * web Clipboard API otherwise. Best-effort — a rejection (permissions,
 * no gesture) is swallowed and reported as `false`, matching the
 * "no clipboard" contract the readers use. No haptic here so callers
 * (e.g. the background auto-clear) can write silently.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { Clipboard } = await import('@capacitor/clipboard');
      await Clipboard.write({ string: text });
    } else {
      await navigator.clipboard.writeText(text);
    }
    return true;
  } catch {
    return false;
  }
}

/** Copies text to clipboard. Returns true on success. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const ok = await writeClipboard(text);
  if (ok) {
    // A plain (non-sensitive) copy makes the last thing on the clipboard
    // non-sensitive, so any pending sensitive auto-clear no longer "owns"
    // the clipboard — revoke ownership so a stale timer can't wipe what
    // the user just copied. See `copySensitive`.
    lastSensitiveValue = null;
    void triggerHapticNotification('success');
  }
  return ok;
}

/**
 * Clears the clipboard by overwriting it with an empty string.
 * Best-effort and silent (no haptic). Returns true on success.
 */
export async function clearClipboard(): Promise<boolean> {
  return writeClipboard('');
}

/**
 * The most-recent value written via `copySensitive`, or `null` when the
 * last write was non-sensitive / already cleared. Module-scoped so every
 * sensitive-copy site shares ONE owner slot: the last sensitive copy
 * wins, and a scheduled clear only fires while it still owns the
 * clipboard. This is the fallback no-clobber guard for platforms where
 * the clipboard can't be read back (see `copySensitive`).
 */
let lastSensitiveValue: string | null = null;

/**
 * Default auto-clear delay for a sensitive copy. 60s balances "long
 * enough to switch to the merchant/notes app and paste" against "short
 * enough that a gift-card code/PIN doesn't linger for any later paste to
 * read". Password managers clear the clipboard on this order (KeePassXC
 * ~10s, Bitwarden/1Password up to ~90s); 60s sits in the middle, and
 * follows OWASP's general guidance to minimise a secret's lifetime on
 * the clipboard. Callers may override via `clearAfterMs`.
 */
const SENSITIVE_CLEAR_MS = 60_000;

/**
 * Clears the clipboard IFF the value we wrote is still there, so we never
 * clobber something the user copied afterwards. Two guards:
 *   1. Ownership: only clear while `value` is still the last value handed
 *      to `copySensitive`. A newer sensitive copy, or any plain
 *      `copyToClipboard`, revokes ownership.
 *   2. Read-back: where the platform lets us read the clipboard, clear
 *      only if it still equals `value`. If the user copied something else
 *      meanwhile, leave it. If the read is unavailable (permissions →
 *      `readClipboard` yields `null`), fall back to the ownership guard
 *      alone (which already passed).
 */
async function clearSensitiveIfUnchanged(value: string): Promise<void> {
  if (lastSensitiveValue !== value) return;
  const current = await readClipboard();
  if (current !== null && current !== value) return;
  await clearClipboard();
  if (lastSensitiveValue === value) lastSensitiveValue = null;
}

/**
 * Copies a SENSITIVE value (a gift-card code or PIN) to the clipboard and
 * schedules a guarded auto-clear after `clearAfterMs` (default 60s), so
 * the secret doesn't linger indefinitely for any later app/site paste to
 * read. The clear will not wipe a value the user copied in the meantime —
 * see `clearSensitiveIfUnchanged`. Use this for redemption values; use
 * `copyToClipboard` for non-sensitive copies (payment address, memo,
 * order id) that should persist.
 */
export async function copySensitive(
  text: string,
  { clearAfterMs = SENSITIVE_CLEAR_MS }: { clearAfterMs?: number } = {},
): Promise<boolean> {
  // Delegates the write (+ success haptic). copyToClipboard resets
  // ownership to null; we then claim it for `text`.
  const ok = await copyToClipboard(text);
  if (!ok) return false;
  lastSensitiveValue = text;
  setTimeout(() => {
    void clearSensitiveIfUnchanged(text);
  }, clearAfterMs);
  return true;
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
