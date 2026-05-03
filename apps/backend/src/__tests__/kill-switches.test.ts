import { describe, it, expect, afterEach } from 'vitest';
import { isKilled } from '../kill-switches.js';

describe('isKilled — A2-1907 runtime kill switches', () => {
  afterEach(() => {
    delete process.env.LOOP_KILL_ORDERS;
    delete process.env.LOOP_KILL_AUTH;
    delete process.env.LOOP_KILL_WITHDRAWALS;
  });

  it('returns false when env var is unset (fail-open)', () => {
    expect(isKilled('orders')).toBe(false);
    expect(isKilled('auth')).toBe(false);
    expect(isKilled('withdrawals')).toBe(false);
  });

  it('returns true on each accepted truthy value, case-insensitive', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'YES', 'on']) {
      process.env.LOOP_KILL_ORDERS = v;
      expect(isKilled('orders')).toBe(true);
    }
  });

  it('returns false on accepted falsy values', () => {
    for (const v of ['false', '0', 'no', 'off', '', '   ']) {
      process.env.LOOP_KILL_ORDERS = v;
      expect(isKilled('orders')).toBe(false);
    }
  });

  it('returns true on unrecognised strings (A4-047 fail-CLOSED)', () => {
    // A4-047: was fail-open. Operators typing `disabled`, `kill`,
    // or any other non-canonical value previously got silent
    // fail-open (kill not engaged). Now fails closed so the
    // typo surfaces as a visible-but-recoverable subsystem
    // outage instead of silently leaving the surface live.
    process.env.LOOP_KILL_ORDERS = 'maybe';
    expect(isKilled('orders')).toBe(true);
    process.env.LOOP_KILL_ORDERS = 'disabled';
    expect(isKilled('orders')).toBe(true);
  });

  it('reads process.env at call-time so a mid-process flip takes effect', () => {
    expect(isKilled('orders')).toBe(false);
    process.env.LOOP_KILL_ORDERS = 'true';
    expect(isKilled('orders')).toBe(true);
    process.env.LOOP_KILL_ORDERS = 'false';
    expect(isKilled('orders')).toBe(false);
  });

  it('isolates each subsystem', () => {
    process.env.LOOP_KILL_AUTH = 'true';
    expect(isKilled('auth')).toBe(true);
    expect(isKilled('orders')).toBe(false);
    expect(isKilled('withdrawals')).toBe(false);
  });
});
