import { describe, it, expect, afterEach } from 'vitest';
import { isKilled } from '../kill-switches.js';

describe('isKilled — A2-1907 runtime kill switches', () => {
  afterEach(() => {
    delete process.env.LOOP_KILL_ORDERS;
    delete process.env.LOOP_KILL_ORDERS_LEGACY;
    delete process.env.LOOP_KILL_ORDERS_LOOP;
    delete process.env.LOOP_KILL_AUTH;
    delete process.env.LOOP_KILL_EMISSIONS;
  });

  it('returns false when env var is unset (fail-open)', () => {
    expect(isKilled('orders-legacy')).toBe(false);
    expect(isKilled('orders-loop')).toBe(false);
    expect(isKilled('auth')).toBe(false);
    expect(isKilled('emissions')).toBe(false);
  });

  it('returns true on each accepted truthy value, case-insensitive', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'YES', 'on']) {
      process.env.LOOP_KILL_ORDERS = v;
      expect(isKilled('orders-legacy')).toBe(true);
      expect(isKilled('orders-loop')).toBe(true);
    }
  });

  it('returns false on accepted falsy values', () => {
    for (const v of ['false', '0', 'no', 'off', '', '   ']) {
      process.env.LOOP_KILL_ORDERS = v;
      expect(isKilled('orders-legacy')).toBe(false);
      expect(isKilled('orders-loop')).toBe(false);
    }
  });

  it('returns true on unrecognised strings (A4-047 fail-CLOSED)', () => {
    // A4-047: was fail-open. Operators typing `disabled`, `kill`,
    // or any other non-canonical value previously got silent
    // fail-open (kill not engaged). Now fails closed so the
    // typo surfaces as a visible-but-recoverable subsystem
    // outage instead of silently leaving the surface live.
    process.env.LOOP_KILL_ORDERS = 'maybe';
    expect(isKilled('orders-legacy')).toBe(true);
    process.env.LOOP_KILL_ORDERS = 'disabled';
    expect(isKilled('orders-loop')).toBe(true);
  });

  it('reads process.env at call-time so a mid-process flip takes effect', () => {
    expect(isKilled('orders-legacy')).toBe(false);
    process.env.LOOP_KILL_ORDERS = 'true';
    expect(isKilled('orders-legacy')).toBe(true);
    process.env.LOOP_KILL_ORDERS = 'false';
    expect(isKilled('orders-legacy')).toBe(false);
  });

  it('isolates each subsystem', () => {
    process.env.LOOP_KILL_AUTH = 'true';
    expect(isKilled('auth')).toBe(true);
    expect(isKilled('orders-legacy')).toBe(false);
    expect(isKilled('orders-loop')).toBe(false);
    expect(isKilled('emissions')).toBe(false);
  });

  describe('per-path order switches (comprehensive-audit 2026-06-11, P10)', () => {
    it('LOOP_KILL_ORDERS_LEGACY gates only the legacy path', () => {
      process.env.LOOP_KILL_ORDERS_LEGACY = 'true';
      expect(isKilled('orders-legacy')).toBe(true);
      expect(isKilled('orders-loop')).toBe(false);
    });

    it('LOOP_KILL_ORDERS_LOOP gates only the loop-native path', () => {
      process.env.LOOP_KILL_ORDERS_LOOP = 'true';
      expect(isKilled('orders-loop')).toBe(true);
      expect(isKilled('orders-legacy')).toBe(false);
    });

    it('falls back to the combined switch when the per-path var is unset', () => {
      process.env.LOOP_KILL_ORDERS = 'true';
      expect(isKilled('orders-legacy')).toBe(true);
      expect(isKilled('orders-loop')).toBe(true);
    });

    it('a set per-path var overrides the combined switch — even an explicit false', () => {
      // The selective-reopen incident shape: combined kill is on, but
      // ops re-opens the loop-native path explicitly.
      process.env.LOOP_KILL_ORDERS = 'true';
      process.env.LOOP_KILL_ORDERS_LOOP = 'false';
      expect(isKilled('orders-legacy')).toBe(true);
      expect(isKilled('orders-loop')).toBe(false);
    });

    it('an unrecognised per-path value fails closed without consulting the fallback', () => {
      process.env.LOOP_KILL_ORDERS = 'false';
      process.env.LOOP_KILL_ORDERS_LEGACY = 'banana';
      expect(isKilled('orders-legacy')).toBe(true);
      expect(isKilled('orders-loop')).toBe(false);
    });
  });
});
