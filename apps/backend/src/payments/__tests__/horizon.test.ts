import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { listAccountPayments, isMatchingIncomingPayment, type HorizonPayment } from '../horizon.js';

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
});
