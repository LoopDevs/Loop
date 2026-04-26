/**
 * A2-1906 — buildDsrExport tests.
 *
 * The handler-side wiring (auth, rate limit, content-disposition) is
 * covered by an integration-style mocked-fetch test in the same
 * suite. The bulk of the contract — what's included, what's redacted,
 * shape stability — is exercised against `buildDsrExport` directly so
 * a refactor to the handler doesn't silently degrade the export
 * payload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// db mock: every table read returns whatever the per-test state slot
// holds. `from(...).where(...)` is a thenable that resolves to
// `state.<table>Rows`. Awaiting `select().from(t).where(eq(...))`
// works because we Promise.resolve at the leaf.
const { state } = vi.hoisted(() => {
  const s: {
    user: Record<string, unknown> | undefined;
    identitiesRows: unknown[];
    creditsRows: unknown[];
    txRows: unknown[];
    ordersRows: unknown[];
    payoutsRows: unknown[];
    /** Tracks what table the next `from()` call refers to so `where()` returns the right slot. */
    lastTable: string | null;
  } = {
    user: undefined,
    identitiesRows: [],
    creditsRows: [],
    txRows: [],
    ordersRows: [],
    payoutsRows: [],
    lastTable: null,
  };
  return { state: s };
});

vi.mock('../../db/schema.js', () => {
  // Tag-style sentinels so the mock can route from() → where() to the
  // right rows slot. Each table is just a tagged object the mock's
  // `from()` reads to set `state.lastTable`.
  return {
    users: { __tag: 'users' },
    userIdentities: { __tag: 'userIdentities', userId: 'userId' },
    userCredits: { __tag: 'userCredits', userId: 'userId' },
    creditTransactions: { __tag: 'creditTransactions', userId: 'userId' },
    orders: { __tag: 'orders', userId: 'userId' },
    pendingPayouts: { __tag: 'pendingPayouts', userId: 'userId' },
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, _value: unknown) => ({ __eq: col }),
}));

vi.mock('../../db/client.js', () => {
  function selectChain(): {
    from: (t: { __tag: string }) => { where: (where: unknown) => Promise<unknown[]> };
  } {
    return {
      from: (t) => {
        state.lastTable = t.__tag;
        return {
          where: async () => {
            switch (state.lastTable) {
              case 'userIdentities':
                return state.identitiesRows;
              case 'userCredits':
                return state.creditsRows;
              case 'creditTransactions':
                return state.txRows;
              case 'orders':
                return state.ordersRows;
              case 'pendingPayouts':
                return state.payoutsRows;
              case null:
              default:
                return [];
            }
          },
        };
      },
    };
  }
  return {
    db: {
      select: () => selectChain(),
      query: {
        users: {
          findFirst: vi.fn(async () => state.user),
        },
      },
    },
  };
});

import { buildDsrExport, DSR_EXPORT_SCHEMA_VERSION } from '../dsr-export.js';

beforeEach(() => {
  state.user = undefined;
  state.identitiesRows = [];
  state.creditsRows = [];
  state.txRows = [];
  state.ordersRows = [];
  state.payoutsRows = [];
});

const NOW = new Date('2026-04-26T12:34:56.000Z');

describe('buildDsrExport (A2-1906)', () => {
  it('returns null when the user does not exist', async () => {
    state.user = undefined;
    const out = await buildDsrExport('missing-id');
    expect(out).toBeNull();
  });

  it('includes the user row, omits the redeem secrets, and reports redeemIssued correctly', async () => {
    state.user = {
      id: 'u-1',
      email: 'alice@example.com',
      isAdmin: false,
      homeCurrency: 'GBP',
      stellarAddress: null,
      ctxUserId: null,
      createdAt: NOW,
    };
    state.ordersRows = [
      {
        id: 'o-redeemed',
        merchantId: 'm1',
        state: 'fulfilled',
        faceValueMinor: 5_000n,
        currency: 'GBP',
        chargeMinor: 5_000n,
        chargeCurrency: 'GBP',
        paymentMethod: 'credit',
        paymentMemo: null,
        userCashbackMinor: 250n,
        ctxOrderId: 'ctx-x',
        redeemCode: 'SECRET-CODE-12345',
        redeemPin: 'SECRET-PIN-9999',
        redeemUrl: null,
        failureReason: null,
        createdAt: NOW,
        paidAt: NOW,
        fulfilledAt: NOW,
        failedAt: null,
      },
      {
        id: 'o-pending',
        merchantId: 'm2',
        state: 'pending_payment',
        faceValueMinor: 2_500n,
        currency: 'GBP',
        chargeMinor: 2_500n,
        chargeCurrency: 'GBP',
        paymentMethod: 'xlm',
        paymentMemo: 'MEMOABCD',
        userCashbackMinor: 125n,
        ctxOrderId: null,
        redeemCode: null,
        redeemPin: null,
        redeemUrl: null,
        failureReason: null,
        createdAt: NOW,
        paidAt: null,
        fulfilledAt: null,
        failedAt: null,
      },
    ];

    const out = await buildDsrExport('u-1');
    expect(out).not.toBeNull();
    if (out === null) throw new Error('unreachable');

    expect(out.schemaVersion).toBe(DSR_EXPORT_SCHEMA_VERSION);
    expect(out.user.email).toBe('alice@example.com');

    const orderJson = JSON.stringify(out.orders);
    // Critical: the secret material must NOT leak even though we read
    // it from the DB row to set `redeemIssued`.
    expect(orderJson).not.toContain('SECRET-CODE-12345');
    expect(orderJson).not.toContain('SECRET-PIN-9999');

    expect(out.orders[0]?.redeemIssued).toBe(true);
    expect(out.orders[1]?.redeemIssued).toBe(false);
  });

  it('serialises bigint fields as strings to keep the response JSON-safe past 2^53', async () => {
    state.user = {
      id: 'u-1',
      email: 'a@b.com',
      isAdmin: false,
      homeCurrency: 'USD',
      stellarAddress: null,
      ctxUserId: null,
      createdAt: NOW,
    };
    state.creditsRows = [
      // Past 2^53 — the export would lose precision if the server
      // serialised this as a JS number.
      { currency: 'USD', balanceMinor: 9_999_999_999_999_999n, updatedAt: NOW },
    ];
    state.txRows = [
      {
        id: 't-1',
        type: 'cashback',
        amountMinor: 12_345_678_901_234_567n,
        currency: 'USD',
        referenceType: 'order',
        referenceId: 'o-1',
        reason: null,
        createdAt: NOW,
      },
    ];
    state.payoutsRows = [
      {
        id: 'p-1',
        state: 'pending',
        kind: 'order_cashback',
        orderId: 'o-1',
        amountStroops: 8_700_000_000_000n,
        assetCode: 'USDLOOP',
        assetIssuer: 'GISSUER',
        toAddress: 'GUSER',
        memoText: 'memo',
        txHash: null,
        lastError: null,
        attempts: 0,
        createdAt: NOW,
        submittedAt: null,
        confirmedAt: null,
        failedAt: null,
      },
    ];

    const out = await buildDsrExport('u-1');
    expect(out).not.toBeNull();
    if (out === null) throw new Error('unreachable');

    expect(out.credits[0]?.balanceMinor).toBe('9999999999999999');
    expect(out.creditTransactions[0]?.amountMinor).toBe('12345678901234567');
    expect(out.pendingPayouts[0]?.amountStroops).toBe('8700000000000');
    // Round-tripping: parse back and confirm no precision loss.
    expect(BigInt(out.credits[0]!.balanceMinor)).toBe(9_999_999_999_999_999n);
  });

  it('exposes the fallback contact + excluded list for off-host data sources', async () => {
    state.user = {
      id: 'u-1',
      email: 'a@b.com',
      isAdmin: false,
      homeCurrency: 'USD',
      stellarAddress: null,
      ctxUserId: 'ctx-abc',
      createdAt: NOW,
    };
    const out = await buildDsrExport('u-1');
    expect(out).not.toBeNull();
    if (out === null) throw new Error('unreachable');

    expect(out.notes.fallbackContact).toBe('privacy@loopfinance.io');
    expect(out.notes.excluded.length).toBeGreaterThan(0);
    // The exclusion list must mention CTX-side data and off-host
    // logs so a reader knows where else to ask.
    const all = out.notes.excluded.join(' ');
    expect(all).toMatch(/CTX/);
    expect(all).toMatch(/log/i);
  });

  it('user.ctxUserId is preserved (CTX mapping is part of the user-attributable data)', async () => {
    state.user = {
      id: 'u-1',
      email: 'a@b.com',
      isAdmin: false,
      homeCurrency: 'USD',
      stellarAddress: null,
      ctxUserId: 'ctx-mapping-1234',
      createdAt: NOW,
    };
    const out = await buildDsrExport('u-1');
    expect(out?.user.ctxUserId).toBe('ctx-mapping-1234');
  });

  it('passes through identities rows verbatim', async () => {
    state.user = {
      id: 'u-1',
      email: 'a@b.com',
      isAdmin: false,
      homeCurrency: 'USD',
      stellarAddress: null,
      ctxUserId: null,
      createdAt: NOW,
    };
    state.identitiesRows = [
      {
        id: 'id-1',
        provider: 'google',
        providerSub: 'goog-sub-aaaa',
        emailAtLink: 'a@b.com',
        createdAt: NOW,
      },
    ];
    const out = await buildDsrExport('u-1');
    expect(out?.identities).toHaveLength(1);
    expect(out?.identities[0]?.provider).toBe('google');
    expect(out?.identities[0]?.providerSub).toBe('goog-sub-aaaa');
  });
});
