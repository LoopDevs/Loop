import { describe, it, expect } from 'vitest';
import type { UserMeView } from '@loop/shared';
import { resolveStaffRole } from '../use-staff-role';

function me(overrides: Partial<UserMeView>): UserMeView {
  return {
    id: 'u1',
    email: 'u@loop.test',
    isAdmin: false,
    staffRole: null,
    homeCurrency: 'USD',
    stellarAddress: null,
    homeCurrencyBalanceMinor: '0',
    ...overrides,
  };
}

describe('resolveStaffRole (ADR 037)', () => {
  it('returns null when /me has not resolved', () => {
    expect(resolveStaffRole(undefined)).toBeNull();
  });

  it('prefers the explicit staffRole field', () => {
    expect(resolveStaffRole(me({ staffRole: 'support' }))).toBe('support');
    expect(resolveStaffRole(me({ staffRole: 'admin' }))).toBe('admin');
  });

  it('support stays support even if isAdmin were inconsistent', () => {
    // staffRole is authoritative — the deprecated boolean never
    // escalates an explicit support grant.
    expect(resolveStaffRole(me({ staffRole: 'support', isAdmin: true }))).toBe('support');
  });

  it('falls back to isAdmin for a pre-ADR-037 backend payload', () => {
    expect(resolveStaffRole(me({ staffRole: null, isAdmin: true }))).toBe('admin');
    // A payload that omits the field entirely behaves the same.
    const legacy = me({ isAdmin: true });
    delete (legacy as Partial<UserMeView>).staffRole;
    expect(resolveStaffRole(legacy)).toBe('admin');
  });

  it('returns null for regular users', () => {
    expect(resolveStaffRole(me({}))).toBeNull();
  });
});
