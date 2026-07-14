/**
 * AGT-06: `DISCORD_NOTIFIERS` is the COMPLETE ops-facing catalog of
 * Discord notifiers the backend can emit — the admin UI renders it as
 * "what signals can this system send us?".
 *
 * The pre-existing coverage test (`admin/__tests__/discord-notifiers`)
 * only checks notifiers RE-EXPORTED through `discord.ts`. A notifier
 * that fires via a DIRECT `discord/monitoring.js` import — the
 * deposit-skip family (`notifyDepositSkipRecorded`,
 * `notifyUnrecognizedDepositRecorded`, `notifyDepositSkipAbandoned`),
 * called from `payments/skipped-payments.ts` — is never re-exported
 * through the parent, so it slipped past that test AND out of the
 * catalog. This test closes the blind spot: it enumerates every
 * `notify*` export from the per-channel notifier modules directly
 * (monitoring re-exports its sibling modules) and asserts each one is
 * cataloged.
 */
import { describe, it, expect } from 'vitest';
import { DISCORD_NOTIFIERS } from '../notifiers-catalog.js';
import * as monitoring from '../monitoring.js';
import * as orders from '../orders.js';
import * as adminAudit from '../admin-audit.js';

function notifierNames(mod: Record<string, unknown>): string[] {
  return Object.keys(mod).filter((k) => k.startsWith('notify') && typeof mod[k] === 'function');
}

const cataloged = new Set(DISCORD_NOTIFIERS.map((n) => n.name));
const firedNotifiers = [
  ...notifierNames(monitoring as unknown as Record<string, unknown>),
  ...notifierNames(orders as unknown as Record<string, unknown>),
  ...notifierNames(adminAudit as unknown as Record<string, unknown>),
];

describe('DISCORD_NOTIFIERS covers every notifier that actually fires (AGT-06)', () => {
  it('sweeps a non-trivial set of real notifiers (guards against an empty enumeration)', () => {
    // Sanity floor so a broken import can't make the coverage assertion
    // below pass vacuously by enumerating nothing.
    expect(firedNotifiers.length).toBeGreaterThan(20);
  });

  it.each(firedNotifiers)('catalog lists %s', (name) => {
    expect(cataloged.has(name)).toBe(true);
  });

  it('lists the deposit-skip notifiers that fire via a direct monitoring.js import', () => {
    for (const name of [
      'notifyDepositSkipRecorded',
      'notifyUnrecognizedDepositRecorded',
      'notifyDepositSkipAbandoned',
    ] as const) {
      // They are genuinely exported (they really fire) — not guessed
      // names — and they must be in the catalog.
      expect(monitoring[name]).toBeTypeOf('function');
      expect(cataloged.has(name)).toBe(true);
    }
  });
});
