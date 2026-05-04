import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { state, mocks } = vi.hoisted(() => ({
  state: {
    row: undefined as { cursor: string | null; updatedAt: Date } | undefined,
  },
  mocks: {
    notifyPaymentWatcherStuck: vi.fn<(args: unknown) => void>(() => undefined),
  },
}));

vi.mock('../../db/client.js', () => ({
  db: {
    query: {
      watcherCursors: {
        findFirst: vi.fn(async () => state.row),
      },
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
  mocks.notifyPaymentWatcherStuck.mockReset();
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
});
