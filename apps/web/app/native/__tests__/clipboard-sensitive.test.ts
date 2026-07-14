// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// FE-05: copying a gift-card CODE or PIN must not leave the secret on the
// clipboard indefinitely. `copySensitive` schedules a guarded auto-clear;
// these tests prove the SCHEDULING + the no-clobber guard with fake timers
// and a mocked clipboard (the only part that needs a real device is the
// on-device clipboard timing itself — out of scope for a unit test).
import { copySensitive, copyToClipboard } from '../clipboard';

const CLEAR_MS = 60_000;

let writeText: ReturnType<typeof vi.fn>;
let readText: ReturnType<typeof vi.fn>;

/** Whether the clipboard was cleared (an empty-string write) at any point. */
function wasCleared(): boolean {
  return writeText.mock.calls.some((call) => call[0] === '');
}

beforeEach(() => {
  vi.useFakeTimers();
  writeText = vi.fn().mockResolvedValue(undefined);
  readText = vi.fn().mockResolvedValue('');
  Object.assign(navigator, { clipboard: { writeText, readText } });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('copySensitive — FE-05 auto-clear', () => {
  it('writes the value immediately and reports success', async () => {
    const ok = await copySensitive('GC-SECRET-1234');
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('GC-SECRET-1234');
    expect(wasCleared()).toBe(false); // not cleared yet
  });

  it('does NOT clear before the delay elapses', async () => {
    await copySensitive('GC-SECRET-1234');
    await vi.advanceTimersByTimeAsync(CLEAR_MS - 1);
    expect(wasCleared()).toBe(false);
  });

  it('clears the clipboard once the delay elapses (still our value)', async () => {
    // Clipboard still holds our value at clear time.
    readText.mockResolvedValue('GC-SECRET-1234');
    await copySensitive('GC-SECRET-1234');
    expect(wasCleared()).toBe(false);
    await vi.advanceTimersByTimeAsync(CLEAR_MS);
    expect(wasCleared()).toBe(true);
  });

  it('respects a custom clearAfterMs', async () => {
    readText.mockResolvedValue('PIN-9876');
    await copySensitive('PIN-9876', { clearAfterMs: 5_000 });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(wasCleared()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(wasCleared()).toBe(true);
  });

  it('no-clobber (read-back): leaves a value the user copied afterwards', async () => {
    // The user copied something else in the meantime — the clipboard now
    // reads back a DIFFERENT value, so the scheduled clear must not wipe it.
    await copySensitive('GC-SECRET-1234');
    readText.mockResolvedValue('user-copied-this-later');
    await vi.advanceTimersByTimeAsync(CLEAR_MS);
    expect(wasCleared()).toBe(false);
  });

  it('no-clobber (ownership fallback): a later plain copy revokes the clear', async () => {
    // Simulate a platform where the clipboard cannot be read back
    // (no readText) — the ownership guard alone must protect a later
    // non-sensitive copy made via copyToClipboard.
    Object.assign(navigator, { clipboard: { writeText } }); // no readText
    await copySensitive('GC-SECRET-1234');
    await copyToClipboard('non-sensitive-address'); // revokes ownership
    writeText.mockClear(); // ignore the writes so far; watch for a clear
    await vi.advanceTimersByTimeAsync(CLEAR_MS);
    expect(wasCleared()).toBe(false);
  });

  it('a newer sensitive copy re-owns; the stale timer does not wipe it', async () => {
    readText.mockResolvedValue('SECOND-CODE');
    await copySensitive('FIRST-CODE', { clearAfterMs: 10_000 });
    await copySensitive('SECOND-CODE', { clearAfterMs: 60_000 });
    // First timer fires: it no longer owns the clipboard -> must not clear.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(wasCleared()).toBe(false);
    // Second timer fires: it still owns -> clears.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(wasCleared()).toBe(true);
  });
});
