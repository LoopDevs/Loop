import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { repoMocks } = vi.hoisted(() => ({
  repoMocks: {
    listClaimablePayouts: vi.fn<
      (opts: { limit?: number; staleSeconds: number; maxAttempts: number }) => Promise<unknown[]>
    >(async () => []),
    markPayoutSubmitted: vi.fn<(id: string) => Promise<unknown>>(async (id: string) => ({ id })),
    markPayoutConfirmed: vi.fn<(args: { id: string; txHash: string }) => Promise<unknown>>(
      async (args: { id: string; txHash: string }) => ({
        id: args.id,
        txHash: args.txHash,
      }),
    ),
    markPayoutFailed: vi.fn<(args: { id: string; reason: string }) => Promise<unknown>>(
      async (args: { id: string; reason: string }) => ({ id: args.id, reason: args.reason }),
    ),
    reclaimSubmittedPayout: vi.fn<
      (args: { id: string; expectedAttempts: number }) => Promise<unknown>
    >(async (args: { id: string; expectedAttempts: number }) => ({
      id: args.id,
      attempts: args.expectedAttempts + 1,
    })),
    // CF-18: hash stamp on a `submitted` row before the network submit.
    // Default returns a row (success); tests that exercise the
    // persist-failure path override it to null.
    recordPayoutTxHash: vi.fn<(args: { id: string; txHash: string }) => Promise<unknown>>(
      async (args: { id: string; txHash: string }) => ({ id: args.id, txHash: args.txHash }),
    ),
  },
}));
vi.mock('../../credits/pending-payouts.js', () => ({
  listClaimablePayouts: (opts: { limit?: number; staleSeconds: number; maxAttempts: number }) =>
    repoMocks.listClaimablePayouts(opts),
  markPayoutSubmitted: (id: string) => repoMocks.markPayoutSubmitted(id),
  markPayoutConfirmed: (args: { id: string; txHash: string }) =>
    repoMocks.markPayoutConfirmed(args),
  markPayoutFailed: (args: { id: string; reason: string }) => repoMocks.markPayoutFailed(args),
  reclaimSubmittedPayout: (args: { id: string; expectedAttempts: number }) =>
    repoMocks.reclaimSubmittedPayout(args),
  recordPayoutTxHash: (args: { id: string; txHash: string }) => repoMocks.recordPayoutTxHash(args),
}));

const { horizonMock } = vi.hoisted(() => ({
  horizonMock: {
    findOutboundPaymentByMemo: vi.fn<
      (
        args: unknown,
      ) => Promise<{ txHash: string; amount: string; assetCode: string | null } | null>
    >(async () => null),
    // CF-18: authoritative point lookup by tx hash. Default "never
    // landed" (null) so rows without a persisted hash fall through to
    // the memo scan exactly as before.
    getOutboundPaymentByTxHash: vi.fn<(hash: string) => Promise<{ landed: boolean } | null>>(
      async () => null,
    ),
  },
}));
vi.mock('../horizon.js', () => ({
  findOutboundPaymentByMemo: (args: unknown) => horizonMock.findOutboundPaymentByMemo(args),
  getOutboundPaymentByTxHash: (hash: string) => horizonMock.getOutboundPaymentByTxHash(hash),
}));

// Trustline pre-check (A4-062 follow-up — Phase-2 trustline-probe).
// Default: every destination has the matching trustline. Tests that
// exercise the missing-trustline path override the implementation.
const { trustlinesMock } = vi.hoisted(() => ({
  trustlinesMock: {
    getAccountTrustlines: vi.fn<
      (account: string) => Promise<{
        account: string;
        accountExists: boolean;
        trustlines: Map<string, { code: string; issuer: string }>;
        asOfMs: number;
      }>
    >(async (account: string) => ({
      account,
      accountExists: true,
      // The mock "always trusts everything" — runPayoutTick reads
      // the row's `${assetCode}::${assetIssuer}` key, so giving it
      // a Map with that exact key short-circuits the missing-
      // trustline branch on every default test path. Tests that
      // need to assert against the missing-trustline branch
      // override `mockImplementationOnce` to return an empty Map.
      trustlines: new Map([
        ['USDLOOP::GISSUER', { code: 'USDLOOP', issuer: 'GISSUER' }],
        ['GBPLOOP::GISSUER', { code: 'GBPLOOP', issuer: 'GISSUER' }],
        ['EURLOOP::GISSUER', { code: 'EURLOOP', issuer: 'GISSUER' }],
      ]),
      asOfMs: Date.now(),
    })),
  },
}));
vi.mock('../horizon-trustlines.js', () => ({
  getAccountTrustlines: (account: string) => trustlinesMock.getAccountTrustlines(account),
}));

const { sdkMock, PayoutSubmitErrorMock } = vi.hoisted(() => {
  class PayoutSubmitErrorMock extends Error {
    readonly kind: string;
    constructor(kind: string, msg: string) {
      super(msg);
      this.kind = kind;
    }
  }
  return {
    PayoutSubmitErrorMock,
    sdkMock: {
      // CF-18: the real submitPayout fires `onSigned(hash)` before the
      // network submit. Mirror that here so the worker's persist step
      // (recordPayoutTxHash) is exercised on the default happy path.
      submitPayout: vi.fn<
        (args: { onSigned?: (h: string) => Promise<void> | void }) => Promise<{
          txHash: string;
          ledger: number | null;
        }>
      >(async (args) => {
        await args.onSigned?.('tx-hash');
        return { txHash: 'tx-hash', ledger: 1 };
      }),
    },
  };
});
vi.mock('../payout-submit.js', () => ({
  submitPayout: (args: { onSigned?: (h: string) => Promise<void> | void }) =>
    sdkMock.submitPayout(args),
  PayoutSubmitError: PayoutSubmitErrorMock,
}));

const { discordMock } = vi.hoisted(() => ({
  discordMock: {
    notifyPayoutFailed: vi.fn<(args: unknown) => void>(() => undefined),
    notifyPayoutAwaitingTrustline: vi.fn<(args: unknown) => void>(() => undefined),
  },
}));
vi.mock('../../discord.js', () => ({
  notifyPayoutFailed: (args: unknown) => discordMock.notifyPayoutFailed(args),
  notifyPayoutAwaitingTrustline: (args: unknown) => discordMock.notifyPayoutAwaitingTrustline(args),
}));

// CF-21: the auto-compensation seam. Fully mocked (no importActual) so
// the test doesn't drag in `env.js` / the real DB client. The worker
// imports these exact mocked error classes, so its `instanceof` checks
// resolve against the same identities the tests construct — same
// pattern as `PayoutSubmitErrorMock` above.
const { compensationMock, AlreadyCompensatedErrorMock, PayoutNotCompensableErrorMock } = vi.hoisted(
  () => {
    class AlreadyCompensatedErrorMock extends Error {
      constructor(public readonly payoutId: string) {
        super(`Payout ${payoutId} has already been compensated`);
        this.name = 'AlreadyCompensatedError';
      }
    }
    class PayoutNotCompensableErrorMock extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'PayoutNotCompensableError';
      }
    }
    return {
      AlreadyCompensatedErrorMock,
      PayoutNotCompensableErrorMock,
      compensationMock: {
        applyAdminPayoutCompensation: vi.fn<(args: unknown) => Promise<unknown>>(async () => ({
          id: 'comp-1',
          payoutId: 'p-1',
          userId: 'u-1',
          currency: 'GBP',
          amountMinor: 500n,
          priorBalanceMinor: 0n,
          newBalanceMinor: 500n,
          createdAt: new Date(),
        })),
      },
    };
  },
);
vi.mock('../../credits/payout-compensation.js', () => ({
  applyAdminPayoutCompensation: (args: unknown) =>
    compensationMock.applyAdminPayoutCompensation(args),
  AlreadyCompensatedError: AlreadyCompensatedErrorMock,
  PayoutNotCompensableError: PayoutNotCompensableErrorMock,
}));

// CF-15: the kill-switch seam. Default: nothing killed.
const { killMock } = vi.hoisted(() => ({ killMock: { isKilled: vi.fn((_s: string) => false) } }));
vi.mock('../../kill-switches.js', () => ({
  isKilled: (subsystem: string) => killMock.isKilled(subsystem),
}));

import { runPayoutTick } from '../payout-worker.js';

const BASE_ARGS = {
  operatorSecret: 'SXXX',
  // A4-104: explicit operator pubkey for the Horizon idempotency
  // pre-check. Distinct from `assetIssuer` (`GISSUER` in
  // `makeRow`) so a regression on the lookup-account fix would
  // immediately surface as the prior-payment scan querying the
  // wrong account.
  operatorAccount: 'GOPERATOR',
  horizonUrl: 'https://horizon.example',
  networkPassphrase: 'PUBLIC_NETWORK',
  maxAttempts: 5,
};

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p-1',
    userId: 'u-1',
    orderId: 'o-1',
    assetCode: 'GBPLOOP',
    assetIssuer: 'GISSUER',
    toAddress: 'GDESTINATION',
    amountStroops: 50_000_000n,
    memoText: 'order-abc',
    state: 'pending',
    attempts: 0,
    // CF-18: rows start with no persisted hash. The authoritative
    // hash-lookup pre-check only fires when this is non-null (a re-pick
    // of a row whose prior attempt recorded its hash).
    txHash: null,
    ...overrides,
  };
}

beforeEach(() => {
  repoMocks.listClaimablePayouts.mockReset();
  repoMocks.markPayoutSubmitted.mockReset();
  repoMocks.markPayoutConfirmed.mockReset();
  repoMocks.markPayoutFailed.mockReset();
  repoMocks.reclaimSubmittedPayout.mockReset();
  repoMocks.recordPayoutTxHash.mockReset();
  horizonMock.findOutboundPaymentByMemo.mockReset();
  horizonMock.getOutboundPaymentByTxHash.mockReset();
  sdkMock.submitPayout.mockReset();
  // Sensible defaults.
  repoMocks.listClaimablePayouts.mockResolvedValue([]);
  repoMocks.markPayoutSubmitted.mockImplementation(async (id: string) => ({ id }));
  repoMocks.reclaimSubmittedPayout.mockImplementation(
    async (args: { id: string; expectedAttempts: number }) => ({
      id: args.id,
      attempts: args.expectedAttempts + 1,
    }),
  );
  repoMocks.markPayoutConfirmed.mockImplementation(
    async (args: { id: string; txHash: string }) => ({ id: args.id, txHash: args.txHash }),
  );
  repoMocks.markPayoutFailed.mockImplementation(async (args: { id: string; reason: string }) => ({
    id: args.id,
    reason: args.reason,
  }));
  repoMocks.recordPayoutTxHash.mockImplementation(async (args: { id: string; txHash: string }) => ({
    id: args.id,
    txHash: args.txHash,
  }));
  horizonMock.findOutboundPaymentByMemo.mockResolvedValue(null);
  horizonMock.getOutboundPaymentByTxHash.mockResolvedValue(null);
  sdkMock.submitPayout.mockImplementation(
    async (args: { onSigned?: (h: string) => Promise<void> | void }) => {
      await args.onSigned?.('tx-hash');
      return { txHash: 'tx-hash', ledger: 1 };
    },
  );
  discordMock.notifyPayoutFailed.mockClear();
  compensationMock.applyAdminPayoutCompensation.mockReset();
  compensationMock.applyAdminPayoutCompensation.mockResolvedValue({
    id: 'comp-1',
    payoutId: 'p-1',
    userId: 'u-1',
    currency: 'GBP',
    amountMinor: 500n,
    priorBalanceMinor: 0n,
    newBalanceMinor: 500n,
    createdAt: new Date(),
  });
  killMock.isKilled.mockReset();
  killMock.isKilled.mockReturnValue(false);
});

describe('runPayoutTick', () => {
  it('no pending rows → zero counts, no calls', async () => {
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.picked).toBe(0);
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  // ───────────────────────── trustline pre-check ─────────────────────────
  // (Phase-2 trustline-probe; ADR-015/016 §"trustline-probe before
  // payout submit"). Default is "trustline exists" via the hoisted
  // mock; these tests override `mockImplementationOnce` to flip
  // through the missing-trustline + Horizon-degraded branches.

  it('missing trustline → retriedLater, no submit, no claim, ops notified', async () => {
    trustlinesMock.getAccountTrustlines.mockImplementationOnce(async () => ({
      account: 'GDESTINATION',
      accountExists: true,
      trustlines: new Map(), // ← no trustlines at all
      asOfMs: Date.now(),
    }));
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.confirmed).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.retriedLater).toBe(1);
    expect(repoMocks.markPayoutSubmitted).not.toHaveBeenCalled();
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
    expect(discordMock.notifyPayoutAwaitingTrustline).toHaveBeenCalledTimes(1);
    expect(discordMock.notifyPayoutAwaitingTrustline).toHaveBeenCalledWith(
      expect.objectContaining({
        payoutId: 'p-1',
        userId: 'u-1',
        account: 'GDESTINATION',
        assetCode: 'GBPLOOP',
        accountExists: true,
      }),
    );
  });

  it('trustline read failure → retriedLater (fail-closed) without submitting', async () => {
    trustlinesMock.getAccountTrustlines.mockRejectedValueOnce(new Error('horizon 503'));
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.retriedLater).toBe(1);
    expect(repoMocks.markPayoutSubmitted).not.toHaveBeenCalled();
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  it('trustline exists but for a different issuer → still missing, no submit', async () => {
    // The row is for GBPLOOP::GISSUER but the destination only
    // trusts GBPLOOP::GDIFFERENT_ISSUER. Per CSP-shaped logic the
    // (code, issuer) pair must match exactly — partial matches
    // would let an attacker substitute their own issuer.
    trustlinesMock.getAccountTrustlines.mockImplementationOnce(async () => ({
      account: 'GDESTINATION',
      accountExists: true,
      trustlines: new Map([['GBPLOOP::GDIFFERENT', { code: 'GBPLOOP', issuer: 'GDIFFERENT' }]]),
      asOfMs: Date.now(),
    }));
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.retriedLater).toBe(1);
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  it('happy path: pre-check null → submit → confirm', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.confirmed).toBe(1);
    expect(horizonMock.findOutboundPaymentByMemo).toHaveBeenCalledTimes(1);
    expect(repoMocks.markPayoutSubmitted).toHaveBeenCalledWith('p-1');
    expect(sdkMock.submitPayout).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ to: 'GDESTINATION', assetCode: 'GBPLOOP' }),
      }),
    );
    expect(repoMocks.markPayoutConfirmed).toHaveBeenCalledWith({ id: 'p-1', txHash: 'tx-hash' });
  });

  it('A4-104: pre-check scans the operator account, NOT the asset issuer', async () => {
    // A treasury topology that splits issuer (cold) from operator
    // (hot) is intended to be supported. The earlier code reused
    // `row.assetIssuer` for the lookup account; this test pins the
    // fix so a regression to that behaviour is caught here.
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    await runPayoutTick(BASE_ARGS);
    expect(horizonMock.findOutboundPaymentByMemo).toHaveBeenCalledWith(
      expect.objectContaining({
        account: 'GOPERATOR',
        to: 'GDESTINATION',
        memo: 'order-abc',
      }),
    );
    expect(horizonMock.findOutboundPaymentByMemo).not.toHaveBeenCalledWith(
      expect.objectContaining({ account: 'GISSUER' }),
    );
  });

  it('idempotency pre-check finds prior submit → converges to confirmed without re-submitting', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    horizonMock.findOutboundPaymentByMemo.mockResolvedValue({
      txHash: 'prior-tx',
      amount: '5.0000000',
      assetCode: 'GBPLOOP',
    });
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedAlreadyLanded).toBe(1);
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
    expect(repoMocks.markPayoutConfirmed).toHaveBeenCalledWith({
      id: 'p-1',
      txHash: 'prior-tx',
    });
  });

  it('pre-check race (markConfirmed returns null) counts as skippedRace', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    horizonMock.findOutboundPaymentByMemo.mockResolvedValue({
      txHash: 'prior-tx',
      amount: '5.0000000',
      assetCode: 'GBPLOOP',
    });
    repoMocks.markPayoutConfirmed.mockResolvedValue(null);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedRace).toBe(1);
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  it('markSubmitted race (another worker claimed it) counts as skippedRace, no submit', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    repoMocks.markPayoutSubmitted.mockResolvedValue(null);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedRace).toBe(1);
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  it('pre-check failure fails closed and does not submit a payout', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    horizonMock.findOutboundPaymentByMemo.mockRejectedValue(new Error('horizon down'));
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.retriedLater).toBe(1);
    expect(repoMocks.markPayoutSubmitted).not.toHaveBeenCalled();
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  // ─────────────────────────── CF-18 ───────────────────────────
  // Authoritative tx-hash idempotency + hash persistence before submit.

  it('CF-18: pre-check matches the memo scan with amount+asset pinned (P2-1)', async () => {
    // The memo scan must be called with the row's expected amount +
    // asset so a memo collision can't converge the wrong payment.
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    await runPayoutTick(BASE_ARGS);
    expect(horizonMock.findOutboundPaymentByMemo).toHaveBeenCalledWith(
      expect.objectContaining({
        account: 'GOPERATOR',
        to: 'GDESTINATION',
        memo: 'order-abc',
        expectedAmountStroops: 50_000_000n,
        expectedAssetCode: 'GBPLOOP',
      }),
    );
  });

  it('CF-18: re-pick with a persisted hash that landed → converges via authoritative lookup, no scan, no submit', async () => {
    // A watchdog re-pick of a row whose prior attempt recorded its hash
    // (onSigned → recordPayoutTxHash). The authoritative point lookup
    // proves the tx landed regardless of how many inbound deposits have
    // scrolled the memo-scan window — the core CF-18 fix.
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ state: 'submitted', attempts: 1, txHash: 'persisted-landed-hash' }),
    ]);
    horizonMock.getOutboundPaymentByTxHash.mockResolvedValue({ landed: true });
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedAlreadyLanded).toBe(1);
    expect(horizonMock.getOutboundPaymentByTxHash).toHaveBeenCalledWith('persisted-landed-hash');
    // The window-bound memo scan is NOT consulted — no window dependency.
    expect(horizonMock.findOutboundPaymentByMemo).not.toHaveBeenCalled();
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
    expect(repoMocks.markPayoutConfirmed).toHaveBeenCalledWith({
      id: 'p-1',
      txHash: 'persisted-landed-hash',
    });
  });

  it('CF-18: re-pick with a persisted hash that FAILED on chain → falls through to re-submit', async () => {
    // A persisted hash for a tx that landed but failed (e.g. tx_bad_seq
    // sealed as a failed tx) moved no value, so re-submission is safe.
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ state: 'submitted', attempts: 1, txHash: 'persisted-failed-hash' }),
    ]);
    horizonMock.getOutboundPaymentByTxHash.mockResolvedValue({ landed: false });
    // Memo scan also finds nothing (the prior failed tx isn't a match).
    horizonMock.findOutboundPaymentByMemo.mockResolvedValue(null);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.confirmed).toBe(1);
    expect(horizonMock.getOutboundPaymentByTxHash).toHaveBeenCalledWith('persisted-failed-hash');
    expect(sdkMock.submitPayout).toHaveBeenCalledTimes(1);
  });

  it('CF-18: re-pick with a persisted hash that never landed (404 → null) → re-submits', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ state: 'submitted', attempts: 1, txHash: 'persisted-never-landed' }),
    ]);
    horizonMock.getOutboundPaymentByTxHash.mockResolvedValue(null);
    horizonMock.findOutboundPaymentByMemo.mockResolvedValue(null);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.confirmed).toBe(1);
    expect(sdkMock.submitPayout).toHaveBeenCalledTimes(1);
  });

  it('CF-18: authoritative lookup throwing fails closed (no submit)', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ state: 'submitted', attempts: 1, txHash: 'persisted-hash' }),
    ]);
    horizonMock.getOutboundPaymentByTxHash.mockRejectedValue(new Error('horizon 503'));
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.retriedLater).toBe(1);
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  it('CF-18: the deterministic hash is persisted (recordPayoutTxHash) BEFORE submit returns', async () => {
    // The happy-path submitPayout mock fires onSigned('tx-hash'); the
    // worker must persist it via recordPayoutTxHash so a crash after the
    // tx lands is recoverable on the next re-pick.
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.confirmed).toBe(1);
    expect(repoMocks.recordPayoutTxHash).toHaveBeenCalledWith({ id: 'p-1', txHash: 'tx-hash' });
  });

  it('CF-18: a hash-persist failure aborts the submit (fail-closed)', async () => {
    // recordPayoutTxHash returning null means the row moved out from
    // under us between claim and stamp. onSigned throws → submitPayout
    // surfaces it as terminal_other → the row is not double-submitted.
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    repoMocks.recordPayoutTxHash.mockResolvedValue(null);
    // Use the REAL submitPayout contract: onSigned throws inside it →
    // it would throw PayoutSubmitError('terminal_other'). Simulate that
    // by having the mock invoke onSigned and surface its throw.
    sdkMock.submitPayout.mockImplementation(
      async (args: { onSigned?: (h: string) => Promise<void> | void }) => {
        await args.onSigned?.('tx-hash'); // throws → propagates
        return { txHash: 'tx-hash', ledger: 1 };
      },
    );
    const r = await runPayoutTick(BASE_ARGS);
    // The throw is an unclassified error → handleSubmitError → failed
    // (no second submit; markPayoutConfirmed never called).
    expect(r.confirmed).toBe(0);
    expect(repoMocks.markPayoutConfirmed).not.toHaveBeenCalled();
  });

  it('transient_horizon under the attempts cap → retriedLater, no markFailed', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow({ attempts: 1 })]);
    sdkMock.submitPayout.mockRejectedValue(new PayoutSubmitErrorMock('transient_horizon', 'blip'));
    const r = await runPayoutTick({ ...BASE_ARGS, maxAttempts: 5 });
    expect(r.retriedLater).toBe(1);
    expect(r.failed).toBe(0);
    expect(repoMocks.markPayoutFailed).not.toHaveBeenCalled();
  });

  it('transient_rebuild at the attempts cap → markFailed', async () => {
    // attempts=4 → after markSubmitted bumps, used=5. At cap → fail.
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow({ attempts: 4 })]);
    sdkMock.submitPayout.mockRejectedValue(
      new PayoutSubmitErrorMock('transient_rebuild', 'tx_bad_seq'),
    );
    const r = await runPayoutTick({ ...BASE_ARGS, maxAttempts: 5 });
    expect(r.failed).toBe(1);
    expect(repoMocks.markPayoutFailed).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-1' }));
  });

  it('terminal_no_trust immediately marks failed regardless of attempts', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow({ attempts: 0 })]);
    sdkMock.submitPayout.mockRejectedValue(
      new PayoutSubmitErrorMock('terminal_no_trust', 'op_no_trust'),
    );
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.failed).toBe(1);
    expect(repoMocks.markPayoutFailed).toHaveBeenCalled();
  });

  it('unclassified throw falls through to markFailed', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    sdkMock.submitPayout.mockRejectedValue(new Error('socket hang up'));
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.failed).toBe(1);
    expect(repoMocks.markPayoutFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'socket hang up' }),
    );
  });

  it('fires the Discord alert on terminal failure with the classified kind', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow({ attempts: 0 })]);
    sdkMock.submitPayout.mockRejectedValue(
      new PayoutSubmitErrorMock('terminal_no_trust', 'op_no_trust'),
    );
    await runPayoutTick(BASE_ARGS);
    expect(discordMock.notifyPayoutFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        payoutId: 'p-1',
        kind: 'terminal_no_trust',
        reason: 'op_no_trust',
        attempts: 1,
      }),
    );
  });

  it('fires the Discord alert for unclassified throws with kind=unclassified', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    sdkMock.submitPayout.mockRejectedValue(new Error('socket hang up'));
    await runPayoutTick(BASE_ARGS);
    expect(discordMock.notifyPayoutFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'unclassified',
        reason: 'socket hang up',
      }),
    );
  });

  it('does not fire the Discord alert on transient-retry outcomes', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow({ attempts: 1 })]);
    sdkMock.submitPayout.mockRejectedValue(new PayoutSubmitErrorMock('transient_horizon', 'blip'));
    await runPayoutTick({ ...BASE_ARGS, maxAttempts: 5 });
    expect(discordMock.notifyPayoutFailed).not.toHaveBeenCalled();
  });

  it('pre-check throw leaves the row untouched for a later retry', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    horizonMock.findOutboundPaymentByMemo.mockRejectedValue(new Error('Horizon 502'));
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.retriedLater).toBe(1);
    expect(repoMocks.markPayoutSubmitted).not.toHaveBeenCalled();
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  it('confirm race after submit counts as skippedRace (payment did land)', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([makeRow()]);
    repoMocks.markPayoutConfirmed.mockResolvedValue(null);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedRace).toBe(1);
    expect(r.confirmed).toBe(0);
  });

  it('processes rows in order (serialises to respect operator seq numbers)', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ id: 'p-1' }),
      makeRow({ id: 'p-2' }),
      makeRow({ id: 'p-3' }),
    ]);
    const submittedIds: string[] = [];
    sdkMock.submitPayout.mockImplementation(async (args: unknown) => {
      submittedIds.push((args as { intent: { memoText: string } }).intent.memoText);
      return { txHash: `tx-${submittedIds.length}`, ledger: null };
    });
    await runPayoutTick(BASE_ARGS);
    // All 3 rows submitted in the same memo (mock row uses 'order-abc'),
    // but the key invariant is we called submit 3 times, not in
    // parallel.
    expect(sdkMock.submitPayout).toHaveBeenCalledTimes(3);
  });

  it('honours the limit + watchdog args (passes through to listClaimablePayouts)', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([]);
    await runPayoutTick({ ...BASE_ARGS, limit: 3, watchdogStaleSeconds: 120 });
    expect(repoMocks.listClaimablePayouts).toHaveBeenCalledWith({
      limit: 3,
      staleSeconds: 120,
      maxAttempts: 5,
    });
  });

  it('defaults limit to 5 and watchdog staleSeconds to 300 when not given', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([]);
    await runPayoutTick(BASE_ARGS);
    expect(repoMocks.listClaimablePayouts).toHaveBeenCalledWith({
      limit: 5,
      staleSeconds: 300,
      maxAttempts: 5,
    });
  });

  // ─── A2-602 watchdog coverage ──────────────────────────────────

  it('A2-602 watchdog: stuck submitted row, prior submit landed → converges to confirmed via reclaim', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ state: 'submitted', attempts: 1 }),
    ]);
    horizonMock.findOutboundPaymentByMemo.mockResolvedValue({
      txHash: 'landed-tx',
      amount: '5.0000000',
      assetCode: 'GBPLOOP',
    });
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedAlreadyLanded).toBe(1);
    // No second submit — idempotency check short-circuited.
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
    // Row is already 'submitted' so markPayoutSubmitted must NOT be
    // called — the guard expects state='pending' and would fail the
    // CAS. We go straight to confirm.
    expect(repoMocks.markPayoutSubmitted).not.toHaveBeenCalled();
    expect(repoMocks.markPayoutConfirmed).toHaveBeenCalledWith({
      id: 'p-1',
      txHash: 'landed-tx',
    });
  });

  it('A2-602 watchdog: stuck submitted row, prior submit NOT landed → reclaim + fresh submit + confirm', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ state: 'submitted', attempts: 1 }),
    ]);
    horizonMock.findOutboundPaymentByMemo.mockResolvedValue(null);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.confirmed).toBe(1);
    expect(repoMocks.reclaimSubmittedPayout).toHaveBeenCalledWith({
      id: 'p-1',
      expectedAttempts: 1,
    });
    // markPayoutSubmitted reserved for the pending-row path only.
    expect(repoMocks.markPayoutSubmitted).not.toHaveBeenCalled();
    expect(sdkMock.submitPayout).toHaveBeenCalledTimes(1);
    expect(repoMocks.markPayoutConfirmed).toHaveBeenCalledWith({
      id: 'p-1',
      txHash: 'tx-hash',
    });
  });

  it('A2-602 watchdog: reclaim race (another worker claimed it) → skippedRace, no submit', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ state: 'submitted', attempts: 1 }),
    ]);
    repoMocks.reclaimSubmittedPayout.mockResolvedValue(null);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedRace).toBe(1);
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });

  // ─── CF-21: auto-compensation on terminal withdrawal failure ────────

  it('CF-21: a failed WITHDRAWAL payout auto-compensates the user', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ kind: 'withdrawal', orderId: null, attempts: 0 }),
    ]);
    sdkMock.submitPayout.mockRejectedValue(
      new PayoutSubmitErrorMock('terminal_no_trust', 'op_no_trust'),
    );
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.failed).toBe(1);
    expect(repoMocks.markPayoutFailed).toHaveBeenCalled();
    // The user is re-credited via the ADR-024 §5 primitive: currency
    // derived from assetCode (GBPLOOP→GBP), amount = stroops/100_000.
    expect(compensationMock.applyAdminPayoutCompensation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-1',
        currency: 'GBP',
        amountMinor: 500n,
        payoutId: 'p-1',
      }),
    );
  });

  it('CF-21: a failed ORDER_CASHBACK payout is NOT compensated (no net-negative balance)', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ kind: 'order_cashback', attempts: 0 }),
    ]);
    sdkMock.submitPayout.mockRejectedValue(
      new PayoutSubmitErrorMock('terminal_no_trust', 'op_no_trust'),
    );
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.failed).toBe(1);
    expect(compensationMock.applyAdminPayoutCompensation).not.toHaveBeenCalled();
  });

  it('CF-21: compensation is idempotent — AlreadyCompensatedError is swallowed (no throw)', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ kind: 'withdrawal', orderId: null }),
    ]);
    sdkMock.submitPayout.mockRejectedValue(new PayoutSubmitErrorMock('terminal_no_trust', 'fail'));
    compensationMock.applyAdminPayoutCompensation.mockRejectedValue(
      new AlreadyCompensatedErrorMock('p-1'),
    );
    const r = await runPayoutTick(BASE_ARGS);
    // Still counts as failed; the AlreadyCompensated path is a no-op.
    expect(r.failed).toBe(1);
  });

  it('CF-21: a compensation throw does not abort the tick or change the outcome', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ kind: 'withdrawal', orderId: null }),
      makeRow({ id: 'p-2', kind: 'withdrawal', orderId: null }),
    ]);
    sdkMock.submitPayout.mockRejectedValue(new PayoutSubmitErrorMock('terminal_no_trust', 'fail'));
    // First compensation throws (cap hit); the second row must still be
    // processed (no abort).
    compensationMock.applyAdminPayoutCompensation
      .mockRejectedValueOnce(new Error('daily cap hit'))
      .mockResolvedValueOnce({
        id: 'comp-2',
        payoutId: 'p-2',
        userId: 'u-1',
        currency: 'GBP',
        amountMinor: 500n,
        priorBalanceMinor: 0n,
        newBalanceMinor: 500n,
        createdAt: new Date(),
      });
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.failed).toBe(2);
    expect(compensationMock.applyAdminPayoutCompensation).toHaveBeenCalledTimes(2);
  });

  it('CF-21: PayoutNotCompensableError is swallowed (precondition moved under us)', async () => {
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ kind: 'withdrawal', orderId: null }),
    ]);
    sdkMock.submitPayout.mockRejectedValue(new Error('socket hang up'));
    compensationMock.applyAdminPayoutCompensation.mockRejectedValue(
      new PayoutNotCompensableErrorMock('state changed'),
    );
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.failed).toBe(1);
  });

  // ─── CF-15: LOOP_KILL_WITHDRAWALS gates the worker ──────────────────

  it('CF-15: withdrawals-kill engaged → withdrawal rows skipped, order_cashback still drains', async () => {
    killMock.isKilled.mockImplementation((s: string) => s === 'withdrawals');
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ id: 'w-1', kind: 'withdrawal', orderId: null, memoText: 'withdrawal-memo' }),
      makeRow({ id: 'c-1', kind: 'order_cashback', memoText: 'cashback-memo' }),
    ]);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedKilled).toBe(1);
    // The order_cashback row still submits + confirms.
    expect(r.confirmed).toBe(1);
    expect(sdkMock.submitPayout).toHaveBeenCalledTimes(1);
    // The single submit was the cashback row, never the withdrawal one.
    expect(sdkMock.submitPayout).toHaveBeenCalledWith(
      expect.objectContaining({ intent: expect.objectContaining({ memoText: 'cashback-memo' }) }),
    );
    expect(sdkMock.submitPayout).not.toHaveBeenCalledWith(
      expect.objectContaining({ intent: expect.objectContaining({ memoText: 'withdrawal-memo' }) }),
    );
  });

  it('CF-15: withdrawals-kill OFF → withdrawal rows process normally', async () => {
    killMock.isKilled.mockReturnValue(false);
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ id: 'w-1', kind: 'withdrawal', orderId: null }),
    ]);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedKilled).toBe(0);
    expect(r.confirmed).toBe(1);
    expect(sdkMock.submitPayout).toHaveBeenCalledTimes(1);
  });

  it('CF-15: the kill switch is read once per tick (live process.env)', async () => {
    killMock.isKilled.mockImplementation((s: string) => s === 'withdrawals');
    repoMocks.listClaimablePayouts.mockResolvedValue([
      makeRow({ id: 'w-1', kind: 'withdrawal', orderId: null }),
      makeRow({ id: 'w-2', kind: 'withdrawal', orderId: null }),
    ]);
    const r = await runPayoutTick(BASE_ARGS);
    expect(r.skippedKilled).toBe(2);
    // One read per tick, not per row.
    expect(killMock.isKilled).toHaveBeenCalledTimes(1);
    expect(killMock.isKilled).toHaveBeenCalledWith('withdrawals');
    // No on-chain submit at all while engaged + only withdrawals queued.
    expect(sdkMock.submitPayout).not.toHaveBeenCalled();
  });
});
