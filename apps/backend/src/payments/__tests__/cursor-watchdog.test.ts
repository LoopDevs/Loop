import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { state, mocks } = vi.hoisted(() => ({
  state: {
    row: undefined as { cursor: string | null; updatedAt: Date } | undefined,
    /** S4-8: whether the pg_try_advisory_xact_lock probe "acquires". */
    advisoryAcquired: true,
  },
  mocks: {
    notifyPaymentWatcherStuck: vi.fn<(args: unknown) => void>(() => undefined),
    txExecute: vi.fn(),
  },
}));

// S4-8: db.transaction + pg_try_advisory_xact_lock mock — same shape
// as ledger-invariant-watcher.test.ts. The transaction callback gets
// a `tx` exposing both `.execute` (the lock probe) and `.query` (the
// cursor lookup, same shape as the un-transacted `db.query` used
// pre-S4-8).
vi.mock('../../db/client.js', () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: mocks.txExecute.mockImplementation(async () => [
          { locked: state.advisoryAcquired },
        ]),
        query: {
          watcherCursors: {
            findFirst: vi.fn(async () => state.row),
          },
        },
      };
      return fn(tx);
    },
  },
}));

vi.mock('../../db/schema.js', () => ({
  watcherCursors: { name: 'name', cursor: 'cursor', updatedAt: 'updated_at' },
}));

vi.mock('../../discord.js', () => ({
  notifyPaymentWatcherStuck: (args: unknown) => mocks.notifyPaymentWatcherStuck(args),
}));

import { runCursorWatchdog, __resetCursorWatchdogForTests } from '../cursor-watchdog.js';

beforeEach(() => {
  state.row = undefined;
  state.advisoryAcquired = true;
  mocks.notifyPaymentWatcherStuck.mockReset();
  mocks.txExecute.mockClear();
  __resetCursorWatchdogForTests();
});

describe('runCursorWatchdog', () => {
  it('no-ops silently when the cursor row does not yet exist (cold deploy)', async () => {
    state.row = undefined;
    await runCursorWatchdog();
    expect(mocks.notifyPaymentWatcherStuck).not.toHaveBeenCalled();
  });

  it('does not page when cursor age is below the stale threshold', async () => {
    state.row = { cursor: 'pt-1', updatedAt: new Date(Date.now() - 60_000) }; // 1 min old
    await runCursorWatchdog();
    expect(mocks.notifyPaymentWatcherStuck).not.toHaveBeenCalled();
  });

  it('pages once on the first stale tick (>10 min)', async () => {
    state.row = {
      cursor: 'pt-1',
      updatedAt: new Date(Date.now() - 11 * 60 * 1000),
    };
    await runCursorWatchdog();
    expect(mocks.notifyPaymentWatcherStuck).toHaveBeenCalledTimes(1);
    const args = mocks.notifyPaymentWatcherStuck.mock.calls[0]![0] as {
      cursorAgeMs: number;
      lastCursor: string;
      lastUpdatedAtMs: number;
    };
    expect(args.lastCursor).toBe('pt-1');
    expect(args.cursorAgeMs).toBeGreaterThan(10 * 60 * 1000);
  });

  it('does not re-page during the same stuck period (one-shot gate)', async () => {
    state.row = {
      cursor: 'pt-1',
      updatedAt: new Date(Date.now() - 11 * 60 * 1000),
    };
    await runCursorWatchdog();
    await runCursorWatchdog();
    await runCursorWatchdog();
    expect(mocks.notifyPaymentWatcherStuck).toHaveBeenCalledTimes(1);
  });

  it('resets the gate when the cursor recovers — next stall pages fresh', async () => {
    state.row = {
      cursor: 'pt-1',
      updatedAt: new Date(Date.now() - 11 * 60 * 1000),
    };
    await runCursorWatchdog();
    expect(mocks.notifyPaymentWatcherStuck).toHaveBeenCalledTimes(1);

    // Cursor moved — watchdog sees a fresh updated_at.
    state.row = { cursor: 'pt-2', updatedAt: new Date() };
    await runCursorWatchdog();
    expect(mocks.notifyPaymentWatcherStuck).toHaveBeenCalledTimes(1); // still one

    // Now stalls again — should page fresh because the gate reset.
    state.row = { cursor: 'pt-2', updatedAt: new Date(Date.now() - 11 * 60 * 1000) };
    await runCursorWatchdog();
    expect(mocks.notifyPaymentWatcherStuck).toHaveBeenCalledTimes(2);
  });

  it('passes empty string when last cursor is null (typed safely)', async () => {
    state.row = { cursor: null, updatedAt: new Date(Date.now() - 11 * 60 * 1000) };
    await runCursorWatchdog();
    const args = mocks.notifyPaymentWatcherStuck.mock.calls[0]![0] as { lastCursor: string };
    expect(args.lastCursor).toBe('');
  });

  it('S4-8: skips the check when another machine holds the cursor-watchdog lock', async () => {
    state.advisoryAcquired = false;
    state.row = { cursor: 'pt-1', updatedAt: new Date(Date.now() - 11 * 60 * 1000) };
    const r = await runCursorWatchdog();
    expect(r).toEqual({ skippedLocked: true });
    expect(mocks.notifyPaymentWatcherStuck).not.toHaveBeenCalled();
  });

  it('returns skippedLocked: false when it acquires the lock and runs', async () => {
    state.row = undefined;
    const r = await runCursorWatchdog();
    expect(r).toEqual({ skippedLocked: false });
  });
});
