import { describe, expect, it } from 'vitest';

import { PAYOUT_STATES, isPayoutState } from './payout-state.js';

describe('PAYOUT_STATES', () => {
  it('pins the ADR 015/016 payout state machine exactly', () => {
    // Mirrors the `pending_payouts_state_known` CHECK in db/schema.ts.
    expect(PAYOUT_STATES).toEqual(['pending', 'submitted', 'confirmed', 'failed']);
  });

  it('isPayoutState narrows members and rejects non-members', () => {
    for (const s of PAYOUT_STATES) expect(isPayoutState(s)).toBe(true);
    expect(isPayoutState('')).toBe(false);
    expect(isPayoutState('retrying')).toBe(false);
    expect(isPayoutState('CONFIRMED')).toBe(false);
  });
});
