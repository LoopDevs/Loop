import { describe, expect, it } from 'vitest';

import { STAFF_ROLES } from './admin-staff.js';
import { WATCHER_SKIP_REASONS, WATCHER_SKIP_STATUSES } from './admin-support-ops.js';

// The wire-shape modules are mostly types, but their runtime tuples are
// pinned to DB CHECK constraints — the same drift contract as
// order-state/payout-state, so they get the same pin tests.

describe('STAFF_ROLES (ADR 037)', () => {
  it('pins the staff_roles_role_known CHECK exactly', () => {
    expect(STAFF_ROLES).toEqual(['admin', 'support']);
  });
});

describe('watcher-skip enums (migration 0033)', () => {
  it('pins the status tuple', () => {
    expect(WATCHER_SKIP_STATUSES).toEqual(['pending', 'resolved', 'abandoned']);
  });

  it('reasons are unique and non-empty', () => {
    expect(WATCHER_SKIP_REASONS.length).toBeGreaterThan(0);
    expect(new Set(WATCHER_SKIP_REASONS).size).toBe(WATCHER_SKIP_REASONS.length);
  });
});
