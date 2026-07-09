import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  listAccountPayments,
  isMatchingIncomingPayment,
  isInboundDeliveryToAccount,
  findOutboundPaymentByMemo,
  getOutboundPaymentByTxHash,
  type HorizonPayment,
} from '../horizon.js';

const ACCOUNT = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGV';

function paymentResponse(records: unknown[], nextHref?: string): Response {
  return new Response(
    JSON.stringify({
      _embedded: { records },
      _links: nextHref !== undefined ? { next: { href: nextHref } } : undefined,
    }),
    { status: 200, headers: { 'content-type': 'application/hal+json' } },
  );
}

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  delete process.env['LOOP_STELLAR_HORIZON_URL'];
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
});

describe('listAccountPayments', () => {
  it('hits the public Horizon by default with limit/order/join params', async () => {
    const captured: string[] = [];
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      captured.push(String(url));
      return paymentResponse([]);
    });
    await listAccountPayments({ account: ACCOUNT });
    expect(captured).toHaveLength(1);
    const u = new URL(captured[0]!);
    expect(u.origin).toBe('https://horizon.stellar.org');
    expect(u.pathname).toBe(`/accounts/${ACCOUNT}/payments`);
    expect(u.searchParams.get('order')).toBe('asc');
    expect(u.searchParams.get('join')).toBe('transactions');
    expect(u.searchParams.get('limit')).toBe('50');
  });

  it('honours LOOP_STELLAR_HORIZON_URL override', async () => {
    process.env['LOOP_STELLAR_HORIZON_URL'] = 'https://horizon-testnet.stellar.org';
    const captured: string[] = [];
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      captured.push(String(url));
      return paymentResponse([]);
    });
    await listAccountPayments({ account: ACCOUNT });
    expect(captured[0]!).toContain('horizon-testnet.stellar.org');
  });

  it('clamps limit to [1, 200]', async () => {
    const seen: string[] = [];
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      seen.push(new URL(String(url)).searchParams.get('limit') ?? '');
      return paymentResponse([]);
    });
    await listAccountPayments({ account: ACCOUNT, limit: 0 });
    await listAccountPayments({ account: ACCOUNT, limit: 10_000 });
    expect(seen).toEqual(['1', '200']);
  });

  it('includes the cursor param when provided', async () => {
    const captured: URL[] = [];
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      captured.push(new URL(String(url)));
      return paymentResponse([]);
    });
    await listAccountPayments({ account: ACCOUNT, cursor: '123' });
    expect(captured[0]!.searchParams.get('cursor')).toBe('123');
  });

  it('parses records + extracts nextCursor from _links.next.href', async () => {
    const record: unknown = {
      id: 'id-1',
      paging_token: 'pt-1',
      type: 'payment',
      to: ACCOUNT,
      asset_type: 'native',
      amount: '10.0000000',
      transaction_hash: 'tx-1',
      transaction_successful: true,
      transaction: { memo: 'ABCDE', memo_type: 'text' },
    };
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        paymentResponse([record], 'https://horizon.stellar.org/x?cursor=42&limit=50'),
      );
    const out = await listAccountPayments({ account: ACCOUNT });
    expect(out.records).toHaveLength(1);
    expect(out.records[0]!.transaction?.memo).toBe('ABCDE');
    expect(out.nextCursor).toBe('42');
  });

  it('returns nextCursor=null when there is no next link', async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(paymentResponse([]));
    const out = await listAccountPayments({ account: ACCOUNT });
    expect(out.nextCursor).toBeNull();
  });

  it('throws on non-2xx', async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status: 502 }));
    await expect(listAccountPayments({ account: ACCOUNT })).rejects.toThrow(/Horizon 502/);
  });

  it('throws on schema drift', async () => {
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{"not":"what we expect"}', { status: 200 }));
    await expect(listAccountPayments({ account: ACCOUNT })).rejects.toThrow(/schema drift/);
  });

  it("accepts create_account records (no asset_type) so account-bootstrap doesn't fail the watcher", async () => {
    // First-ever record in a newly-funded account's /payments
    // history is the createAccount that activated it. Horizon emits
    // those as `type: 'create_account'` with `starting_balance`,
    // `account`, `funder` — NO `asset_type` field. Tightening the
    // schema to require asset_type used to throw "schema drift",
    // marking every watcher tick failed until the createAccount
    // record paged off (never, since cursor stays at the head).
    // After this fix, asset_type is optional and the watcher's
    // downstream `p.type === 'payment'` gate skips create_account
    // records cleanly.
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      paymentResponse([
        {
          id: '12345-0',
          paging_token: '12345-0',
          type: 'create_account',
          transaction_hash: 'ded010218c41e4252908d29515996ff5e6d0ae7e96bf5e17340e1667130d2d60',
          starting_balance: '5.0000000',
          account: ACCOUNT,
          funder: 'GDUV377PDCHMPTAFJ5S2GUIHFUYMODLZGLXCV4H4O27GFYXEVVRGHBT7',
        },
      ]),
    );
    const result = await listAccountPayments({ account: ACCOUNT });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.type).toBe('create_account');
    expect(result.records[0]!.asset_type).toBeUndefined();
    expect(result.records[0]!.starting_balance).toBe('5.0000000');
  });

  it('accepts account_merge records (no asset_type) the same way', async () => {
    // Same shape, different op. Bundled for defence-in-depth: a
    // future deposit-address rotation might emit account_merge in
    // the watched address's history.
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      paymentResponse([
        {
          id: '67890-0',
          paging_token: '67890-0',
          type: 'account_merge',
          transaction_hash: 'mergehash',
          account: ACCOUNT,
          into: 'GDESTINATIONXXX',
        },
      ]),
    );
    const result = await listAccountPayments({ account: ACCOUNT });
    expect(result.records[0]!.type).toBe('account_merge');
    expect(result.records[0]!.asset_type).toBeUndefined();
  });
});

describe('isMatchingIncomingPayment', () => {
  const base: HorizonPayment = {
    id: 'id-1',
    paging_token: 'pt-1',
    type: 'payment',
    from: 'GOTHER',
    to: ACCOUNT,
    asset_type: 'native',
    amount: '10.0000000',
    transaction_hash: 'tx-1',
    transaction_successful: true,
    transaction: { memo: 'MEMO123', memo_type: 'text', successful: true },
  };

  it('accepts a native-asset payment to the right account with a text memo', () => {
    expect(isMatchingIncomingPayment(base, { account: ACCOUNT, assetCode: null })).toBe(true);
  });

  it('rejects when the payment is not destined for our account', () => {
    expect(
      isMatchingIncomingPayment(
        { ...base, to: 'GSOMEONEELSE' },
        { account: ACCOUNT, assetCode: null },
      ),
    ).toBe(false);
  });

  it('rejects a non-payment op type', () => {
    expect(
      isMatchingIncomingPayment(
        { ...base, type: 'create_account' },
        { account: ACCOUNT, assetCode: null },
      ),
    ).toBe(false);
  });

  it('rejects a failed transaction', () => {
    expect(
      isMatchingIncomingPayment(
        { ...base, transaction_successful: false },
        { account: ACCOUNT, assetCode: null },
      ),
    ).toBe(false);
  });

  it('rejects when there is no text memo', () => {
    expect(
      isMatchingIncomingPayment(
        { ...base, transaction: { ...base.transaction!, memo_type: 'hash' } },
        { account: ACCOUNT, assetCode: null },
      ),
    ).toBe(false);
    expect(
      isMatchingIncomingPayment(
        { ...base, transaction: { ...base.transaction!, memo: '' } },
        { account: ACCOUNT, assetCode: null },
      ),
    ).toBe(false);
  });

  it('matches a USDC credit payment by asset code + issuer', () => {
    const usdc: HorizonPayment = {
      ...base,
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GCENTRE',
    };
    expect(
      isMatchingIncomingPayment(usdc, {
        account: ACCOUNT,
        assetCode: 'USDC',
        assetIssuer: 'GCENTRE',
      }),
    ).toBe(true);
  });

  it('rejects a USDC payment from the wrong issuer', () => {
    const usdc: HorizonPayment = {
      ...base,
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GWRONG',
    };
    expect(
      isMatchingIncomingPayment(usdc, {
        account: ACCOUNT,
        assetCode: 'USDC',
        assetIssuer: 'GCENTRE',
      }),
    ).toBe(false);
  });

  it('rejects a native payment when the caller expected USDC', () => {
    expect(isMatchingIncomingPayment(base, { account: ACCOUNT, assetCode: 'USDC' })).toBe(false);
  });

  // AUDIT-2 finding A: the prior clause was
  // `opts.assetIssuer === undefined || p.asset_issuer === opts.assetIssuer`,
  // which is vacuously true when no issuer is passed — so an
  // unconfigured LOOP_STELLAR_USDC_ISSUER matched a real Circle USDC
  // payment AND an attacker's self-issued fake "USDC" from any
  // account. A credit-asset match must now require a pinned issuer:
  // no issuer configured → no match, ever, for any issuer.
  it('AUDIT-2 finding A: rejects a credit-asset payment of any issuer when no issuer is pinned', () => {
    const realUsdc: HorizonPayment = {
      ...base,
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GCENTRE',
    };
    const fakeUsdc: HorizonPayment = {
      ...base,
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GATTACKERSELFISSUED',
    };
    // No `assetIssuer` in opts at all — the shape watcher.ts produces
    // when `LOOP_STELLAR_USDC_ISSUER` is unset (the key is omitted,
    // not passed as `undefined`).
    expect(isMatchingIncomingPayment(realUsdc, { account: ACCOUNT, assetCode: 'USDC' })).toBe(
      false,
    );
    expect(isMatchingIncomingPayment(fakeUsdc, { account: ACCOUNT, assetCode: 'USDC' })).toBe(
      false,
    );
  });

  // ─────────────────────── AUDIT-2 finding C ───────────────────────

  it('AUDIT-2 finding C: accepts a path_payment_strict_receive delivering the matched asset+memo', () => {
    const usdcViaPath: HorizonPayment = {
      ...base,
      type: 'path_payment_strict_receive',
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GCENTRE',
      source_asset_type: 'native',
      source_amount: '95.0000000',
    };
    expect(
      isMatchingIncomingPayment(usdcViaPath, {
        account: ACCOUNT,
        assetCode: 'USDC',
        assetIssuer: 'GCENTRE',
      }),
    ).toBe(true);
  });

  it('AUDIT-2 finding C: accepts a path_payment_strict_send delivering the matched asset+memo', () => {
    const usdcViaPath: HorizonPayment = {
      ...base,
      type: 'path_payment_strict_send',
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GCENTRE',
    };
    expect(
      isMatchingIncomingPayment(usdcViaPath, {
        account: ACCOUNT,
        assetCode: 'USDC',
        assetIssuer: 'GCENTRE',
      }),
    ).toBe(true);
  });

  it('AUDIT-2 finding C: still rejects create_account / account_merge (not payment-shaped)', () => {
    expect(
      isMatchingIncomingPayment(
        { ...base, type: 'create_account' },
        { account: ACCOUNT, assetCode: null },
      ),
    ).toBe(false);
    expect(
      isMatchingIncomingPayment(
        { ...base, type: 'account_merge' },
        { account: ACCOUNT, assetCode: null },
      ),
    ).toBe(false);
  });
});

describe('isInboundDeliveryToAccount (AUDIT-2 finding C)', () => {
  const base: HorizonPayment = {
    id: 'id-1',
    paging_token: 'pt-1',
    type: 'payment',
    from: 'GOTHER',
    to: ACCOUNT,
    asset_type: 'native',
    amount: '10.0000000',
    transaction_hash: 'tx-1',
    transaction_successful: true,
    transaction: { memo: 'MEMO123', memo_type: 'text', successful: true },
  };

  it('is true for a successful plain payment addressed to the account', () => {
    expect(isInboundDeliveryToAccount(base, ACCOUNT)).toBe(true);
  });

  it('is true for a successful path_payment_strict_receive addressed to the account', () => {
    expect(
      isInboundDeliveryToAccount({ ...base, type: 'path_payment_strict_receive' }, ACCOUNT),
    ).toBe(true);
  });

  it('is true for a successful path_payment_strict_send addressed to the account', () => {
    expect(isInboundDeliveryToAccount({ ...base, type: 'path_payment_strict_send' }, ACCOUNT)).toBe(
      true,
    );
  });

  it('is true regardless of memo type/presence — independent of rail matching', () => {
    expect(
      isInboundDeliveryToAccount(
        { ...base, transaction: { memo: undefined, memo_type: 'hash' } },
        ACCOUNT,
      ),
    ).toBe(true);
    expect(isInboundDeliveryToAccount({ ...base, transaction: undefined }, ACCOUNT)).toBe(true);
  });

  it('is false for the SAME account operator OUTBOUND payment (to !== account) — the critical noise guard', () => {
    // The deposit account IS the operator account (ADR 010) — this is
    // the exact shape a routine outbound payout takes in this feed.
    expect(isInboundDeliveryToAccount({ ...base, from: ACCOUNT, to: 'GRECIPIENT' }, ACCOUNT)).toBe(
      false,
    );
  });

  it('is false for a failed transaction (no value actually moved)', () => {
    expect(isInboundDeliveryToAccount({ ...base, transaction_successful: false }, ACCOUNT)).toBe(
      false,
    );
    expect(
      isInboundDeliveryToAccount(
        { ...base, transaction: { ...base.transaction!, successful: false } },
        ACCOUNT,
      ),
    ).toBe(false);
  });

  it('is false for create_account / account_merge (not payment-shaped)', () => {
    expect(isInboundDeliveryToAccount({ ...base, type: 'create_account' }, ACCOUNT)).toBe(false);
    expect(isInboundDeliveryToAccount({ ...base, type: 'account_merge' }, ACCOUNT)).toBe(false);
  });
});

describe('findOutboundPaymentByMemo', () => {
  const TO = 'GDESTINATION';
  const MEMO = 'order-abc';

  function outboundPayment(overrides: Partial<HorizonPayment> = {}): HorizonPayment {
    return {
      id: 'p-1',
      paging_token: 'pt-1',
      type: 'payment',
      from: ACCOUNT,
      to: TO,
      asset_type: 'credit_alphanum12',
      asset_code: 'GBPLOOP',
      asset_issuer: 'GISSUER',
      amount: '5.0000000',
      transaction_hash: 'tx-abc',
      transaction_successful: true,
      transaction: { memo: MEMO, memo_type: 'text', successful: true },
      ...overrides,
    };
  }

  it('returns the matching tx hash on page 1', async () => {
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(paymentResponse([outboundPayment()]));
    const hit = await findOutboundPaymentByMemo({ account: ACCOUNT, to: TO, memo: MEMO });
    expect(hit).toEqual({ txHash: 'tx-abc', amount: '5.0000000', assetCode: 'GBPLOOP' });
  });

  it('returns null when no record matches the memo', async () => {
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        paymentResponse([outboundPayment({ transaction: { memo: 'other', memo_type: 'text' } })]),
      );
    const hit = await findOutboundPaymentByMemo({ account: ACCOUNT, to: TO, memo: MEMO });
    expect(hit).toBeNull();
  });

  it('returns null when no record matches the destination', async () => {
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(paymentResponse([outboundPayment({ to: 'GOTHER' })]));
    const hit = await findOutboundPaymentByMemo({ account: ACCOUNT, to: TO, memo: MEMO });
    expect(hit).toBeNull();
  });

  it('skips failed txs, incoming payments, and non-text memos', async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      paymentResponse([
        outboundPayment({ transaction_successful: false }), // failed
        outboundPayment({ from: 'GSOMEONEELSE' }), // incoming to our account
        outboundPayment({ transaction: { memo: MEMO, memo_type: 'hash' } }), // hash memo
      ]),
    );
    const hit = await findOutboundPaymentByMemo({ account: ACCOUNT, to: TO, memo: MEMO });
    expect(hit).toBeNull();
  });

  it('walks pages until the match is found (cap respects maxPages)', async () => {
    const pageHrefs = { page2: 'https://horizon.stellar.org/acc/pmts?cursor=pt2' };
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        paymentResponse(
          [outboundPayment({ transaction: { memo: 'wrong', memo_type: 'text' } })],
          pageHrefs.page2,
        ),
      )
      .mockResolvedValueOnce(paymentResponse([outboundPayment()]));
    const hit = await findOutboundPaymentByMemo({ account: ACCOUNT, to: TO, memo: MEMO });
    expect(hit?.txHash).toBe('tx-abc');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns null after scanning maxPages without a match', async () => {
    // Every page yields a non-matching record + a next cursor.
    // Need a fresh Response on each call — Response.json() is single-use.
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockImplementation(async () =>
        paymentResponse(
          [outboundPayment({ transaction: { memo: 'nope', memo_type: 'text' } })],
          'https://horizon.stellar.org/acc/pmts?cursor=x',
        ),
      );
    const hit = await findOutboundPaymentByMemo({
      account: ACCOUNT,
      to: TO,
      memo: MEMO,
      maxPages: 2,
    });
    expect(hit).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('stops early when a page has no records', async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(paymentResponse([]));
    const hit = await findOutboundPaymentByMemo({ account: ACCOUNT, to: TO, memo: MEMO });
    expect(hit).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws on non-2xx', async () => {
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('down', { status: 503 }));
    await expect(
      findOutboundPaymentByMemo({ account: ACCOUNT, to: TO, memo: MEMO }),
    ).rejects.toThrow(/Horizon 503/);
  });

  // ─────────────────────────── CF-18 ───────────────────────────

  it('CF-18: finds the prior payout even when many interleaved inbound deposits precede it', async () => {
    // The operator account == deposit account (ADR 010), so the feed
    // interleaves inbound user deposits with our outbound payouts. The
    // prior payout we're looking for is buried behind 250 inbound
    // deposits (which were pushing it out of the old ~600-record / 3
    // page window in conjunction with other traffic). With the deeper
    // default window + outbound-only filter the scan still finds it.
    const inbound = (i: number): HorizonPayment => ({
      id: `in-${i}`,
      paging_token: `pt-in-${i}`,
      type: 'payment',
      from: 'GSOMEDEPOSITOR',
      to: ACCOUNT, // inbound: someone paid US
      asset_type: 'native',
      amount: '1.0000000',
      transaction_hash: `tx-in-${i}`,
      transaction_successful: true,
      transaction: { memo: `deposit-${i}`, memo_type: 'text', successful: true },
    });
    // Page 1: 200 inbound deposits. Page 2: 50 inbound + the real
    // outbound payout. Old default (3 pages × 200) would still have hit
    // it, but a fixed cap that ALWAYS sits in front of the match is the
    // failure mode — assert the outbound-only filter doesn't false-match
    // any of the 250 inbound records and the match is the outbound one.
    const page1 = Array.from({ length: 200 }, (_, i) => inbound(i));
    const page2 = [...Array.from({ length: 50 }, (_, i) => inbound(200 + i)), outboundPayment()];
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        paymentResponse(page1, 'https://horizon.stellar.org/acc/pmts?cursor=pt-page2'),
      )
      .mockResolvedValueOnce(paymentResponse(page2));
    const hit = await findOutboundPaymentByMemo({ account: ACCOUNT, to: TO, memo: MEMO });
    expect(hit).toEqual({ txHash: 'tx-abc', amount: '5.0000000', assetCode: 'GBPLOOP' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('CF-18: scans up to the deeper default window (8 pages, ~1600 records)', async () => {
    // Every page is non-matching with a next cursor; the scan should run
    // the full default of 8 pages before giving up (vs the old 3).
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockImplementation(async () =>
        paymentResponse(
          [outboundPayment({ transaction: { memo: 'nope', memo_type: 'text' } })],
          'https://horizon.stellar.org/acc/pmts?cursor=x',
        ),
      );
    const hit = await findOutboundPaymentByMemo({ account: ACCOUNT, to: TO, memo: MEMO });
    expect(hit).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(8);
  });

  it('CF-18 / P2-1: a memo+from+to hit with a mismatched amount is skipped, not returned', async () => {
    // Collision: same memo + destination but a DIFFERENT amount. With
    // expectedAmountStroops pinned the scan must NOT converge on it.
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(paymentResponse([outboundPayment({ amount: '9.9999999' })]));
    const hit = await findOutboundPaymentByMemo({
      account: ACCOUNT,
      to: TO,
      memo: MEMO,
      expectedAmountStroops: 50_000_000n, // 5.0000000 — not 9.9999999
      expectedAssetCode: 'GBPLOOP',
    });
    expect(hit).toBeNull();
  });

  it('CF-18 / P2-1: a memo+from+to hit with a mismatched asset is skipped', async () => {
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(paymentResponse([outboundPayment({ asset_code: 'EURLOOP' })]));
    const hit = await findOutboundPaymentByMemo({
      account: ACCOUNT,
      to: TO,
      memo: MEMO,
      expectedAmountStroops: 50_000_000n,
      expectedAssetCode: 'GBPLOOP',
    });
    expect(hit).toBeNull();
  });

  it('CF-18 / P2-1: returns the match when amount+asset both line up (trailing-zero tolerant)', async () => {
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(paymentResponse([outboundPayment({ amount: '5.0000000' })]));
    const hit = await findOutboundPaymentByMemo({
      account: ACCOUNT,
      to: TO,
      memo: MEMO,
      expectedAmountStroops: 50_000_000n,
      expectedAssetCode: 'GBPLOOP',
    });
    expect(hit?.txHash).toBe('tx-abc');
  });
});

describe('getOutboundPaymentByTxHash (CF-18 authoritative lookup)', () => {
  function txResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/hal+json' },
    });
  }

  it('returns { landed: true } for a successful sealed tx', async () => {
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(txResponse({ hash: 'abc', successful: true }));
    expect(await getOutboundPaymentByTxHash('abc')).toEqual({ landed: true });
  });

  it('returns { landed: false } for a tx that sealed but failed', async () => {
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(txResponse({ hash: 'abc', successful: false }));
    expect(await getOutboundPaymentByTxHash('abc')).toEqual({ landed: false });
  });

  it('returns null on 404 (tx never reached a ledger)', async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(txResponse({}, 404));
    expect(await getOutboundPaymentByTxHash('abc')).toBeNull();
  });

  it('throws on a non-404 transport error (fail-closed)', async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(txResponse('down', 503));
    await expect(getOutboundPaymentByTxHash('abc')).rejects.toThrow(/Horizon 503/);
  });

  it('throws on schema drift', async () => {
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(txResponse({ hash: 'abc' /* no successful */ }));
    await expect(getOutboundPaymentByTxHash('abc')).rejects.toThrow(/schema drift/);
  });

  it('hits the GET /transactions/{hash} endpoint with the hash', async () => {
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(txResponse({ hash: 'deadbeef', successful: true }));
    await getOutboundPaymentByTxHash('deadbeef');
    const url = fetchSpy.mock.calls[0]![0] as URL;
    expect(url.toString()).toContain('/transactions/deadbeef');
  });
});
