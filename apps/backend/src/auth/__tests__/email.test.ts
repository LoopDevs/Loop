import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  // env.ts reads NODE_ENV at module load, so we fix it up-front. Tests
  // that need to flip it toggle process.env + resetModules below.
  process.env['NODE_ENV'] = 'test';
});

import { getEmailProvider, __resetEmailProviderForTests } from '../email.js';

beforeEach(() => {
  __resetEmailProviderForTests();
  delete process.env['EMAIL_PROVIDER'];
});

afterEach(() => {
  delete process.env['EMAIL_PROVIDER'];
  __resetEmailProviderForTests();
});

describe('getEmailProvider', () => {
  it('returns the console provider by default in non-production', () => {
    const p = getEmailProvider();
    expect(p.name).toBe('console');
  });

  it('caches the provider across calls', () => {
    const a = getEmailProvider();
    const b = getEmailProvider();
    expect(a).toBe(b);
  });

  it('throws on an unknown EMAIL_PROVIDER value', () => {
    process.env['EMAIL_PROVIDER'] = 'sendgrid';
    expect(() => getEmailProvider()).toThrow(/Unsupported EMAIL_PROVIDER/);
  });

  it('honours an explicit EMAIL_PROVIDER=console in non-production', () => {
    process.env['EMAIL_PROVIDER'] = 'console';
    const p = getEmailProvider();
    expect(p.name).toBe('console');
  });

  // A2-571 production-guard coverage. Loading env.ts in production
  // requires a lot of other env vars (A-025 image-proxy allowlist,
  // etc.) that aren't relevant to this test — instead we mock the env
  // module so the production switch is the only variable under test.
  it('A2-571: refuses EMAIL_PROVIDER=console in production (stub leaks plaintext OTPs)', async () => {
    vi.resetModules();
    vi.doMock('../../env.js', () => ({
      env: { NODE_ENV: 'production', LOG_LEVEL: 'silent' },
    }));
    process.env['EMAIL_PROVIDER'] = 'console';
    const { getEmailProvider: fresh, __resetEmailProviderForTests: freshReset } =
      await import('../email.js');
    freshReset();
    expect(() => fresh()).toThrow(/not permitted in production/);
    vi.doUnmock('../../env.js');
    vi.resetModules();
  });

  it('A2-571: refuses unset EMAIL_PROVIDER in production', async () => {
    vi.resetModules();
    vi.doMock('../../env.js', () => ({
      env: { NODE_ENV: 'production', LOG_LEVEL: 'silent' },
    }));
    delete process.env['EMAIL_PROVIDER'];
    const { getEmailProvider: fresh, __resetEmailProviderForTests: freshReset } =
      await import('../email.js');
    freshReset();
    expect(() => fresh()).toThrow(/not permitted in production/);
    vi.doUnmock('../../env.js');
    vi.resetModules();
  });

  it('throws when EMAIL_PROVIDER=resend but RESEND_API_KEY is missing', () => {
    process.env['EMAIL_PROVIDER'] = 'resend';
    delete process.env['RESEND_API_KEY'];
    expect(() => getEmailProvider()).toThrow(/RESEND_API_KEY/);
  });

  it('returns the resend provider when EMAIL_PROVIDER=resend + RESEND_API_KEY is set', () => {
    process.env['EMAIL_PROVIDER'] = 'resend';
    process.env['RESEND_API_KEY'] = 're_test_xxxxxxxxxxxxxxxx';
    const p = getEmailProvider();
    expect(p.name).toBe('resend');
    delete process.env['RESEND_API_KEY'];
  });
});

describe('ResendEmailProvider.sendOtpEmail', () => {
  beforeEach(() => {
    process.env['EMAIL_PROVIDER'] = 'resend';
    process.env['RESEND_API_KEY'] = 're_test_xxxxxxxxxxxxxxxx';
    delete process.env['EMAIL_FROM_ADDRESS'];
    delete process.env['EMAIL_FROM_NAME'];
    __resetEmailProviderForTests();
  });

  afterEach(() => {
    delete process.env['EMAIL_PROVIDER'];
    delete process.env['RESEND_API_KEY'];
    delete process.env['EMAIL_FROM_ADDRESS'];
    delete process.env['EMAIL_FROM_NAME'];
    __resetEmailProviderForTests();
  });

  it('POSTs to Resend with bearer auth, default from, code in subject + body', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const provider = getEmailProvider();
    await provider.sendOtpEmail({
      to: 'user@example.com',
      code: '654321',
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer re_test_xxxxxxxxxxxxxxxx');
    const body = JSON.parse(String((init as RequestInit).body)) as {
      from: string;
      to: string;
      subject: string;
      text: string;
      html: string;
    };
    expect(body.from).toBe('Loop <noreply@loopfinance.io>');
    expect(body.to).toBe('user@example.com');
    expect(body.subject).toContain('654321');
    expect(body.text).toContain('654321');
    expect(body.html).toContain('654321');
    fetchSpy.mockRestore();
  });

  it('honours EMAIL_FROM_ADDRESS + EMAIL_FROM_NAME overrides', async () => {
    process.env['EMAIL_FROM_ADDRESS'] = 'auth@loopfinance.io';
    process.env['EMAIL_FROM_NAME'] = 'Loop Finance';
    __resetEmailProviderForTests();
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await getEmailProvider().sendOtpEmail({
      to: 'a@b.com',
      code: '111111',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { from: string };
    expect(body.from).toBe('Loop Finance <auth@loopfinance.io>');
    fetchSpy.mockRestore();
  });

  it('throws on a non-2xx Resend response (caller maps to 503 retry)', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('rate limited', { status: 429 }));
    const provider = getEmailProvider();
    await expect(
      provider.sendOtpEmail({
        to: 'a@b.com',
        code: '999999',
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow(/Resend 429/);
    fetchSpy.mockRestore();
  });

  it('escapes HTML-special characters in the code (defence-in-depth)', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    // Real OTPs are 6-digit numerics, but the escape path should
    // still hold for any string in case the format ever changes.
    await getEmailProvider().sendOtpEmail({
      to: 'a@b.com',
      code: '<script>',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { html: string };
    expect(body.html).toContain('&lt;script&gt;');
    expect(body.html).not.toContain('<script>');
    fetchSpy.mockRestore();
  });
});

describe('ConsoleEmailProvider.sendOtpEmail', () => {
  it('resolves without throwing and does not invoke any network call', async () => {
    const p = getEmailProvider();
    await expect(
      p.sendOtpEmail({
        to: 'a@b.com',
        code: '123456',
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toBeUndefined();
  });

  // A2-1612: if @sentry/pino is configured, log records land in the
  // Sentry transport before Pino's REDACT_PATHS pass runs. Guard by
  // checking SENTRY_DSN at the call site; raw code only in the
  // no-Sentry (default dev) branch.
  it('A2-1612: includes the raw code when SENTRY_DSN is unset', async () => {
    vi.resetModules();
    vi.doMock('../../env.js', () => ({ env: { NODE_ENV: 'test', SENTRY_DSN: undefined } }));
    const loggerCalls: Array<[Record<string, unknown>, string]> = [];
    vi.doMock('../../logger.js', () => ({
      logger: {
        child: () => ({
          info: (data: Record<string, unknown>, msg: string) => loggerCalls.push([data, msg]),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        }),
      },
    }));
    const { getEmailProvider: fresh, __resetEmailProviderForTests: reset } =
      await import('../email.js');
    reset();
    await fresh().sendOtpEmail({
      to: 'a@b.com',
      code: '123456',
      expiresAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(loggerCalls[0]![0]['code']).toBe('123456');
    expect(loggerCalls[0]![1]).toMatch(/dev-only/);
    vi.doUnmock('../../env.js');
    vi.doUnmock('../../logger.js');
  });

  it('A2-1612: redacts the code when SENTRY_DSN is set (Sentry pre-redaction protection)', async () => {
    vi.resetModules();
    vi.doMock('../../env.js', () => ({
      env: { NODE_ENV: 'test', SENTRY_DSN: 'https://x@o.ingest.sentry.io/42' },
    }));
    const loggerCalls: Array<[Record<string, unknown>, string]> = [];
    vi.doMock('../../logger.js', () => ({
      logger: {
        child: () => ({
          info: (data: Record<string, unknown>, msg: string) => loggerCalls.push([data, msg]),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        }),
      },
    }));
    const { getEmailProvider: fresh, __resetEmailProviderForTests: reset } =
      await import('../email.js');
    reset();
    await fresh().sendOtpEmail({
      to: 'a@b.com',
      code: '123456',
      expiresAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(loggerCalls[0]![0]['code']).not.toBe('123456');
    expect(String(loggerCalls[0]![0]['code'])).toMatch(/REDACTED/);
    expect(loggerCalls[0]![1]).toMatch(/redacted/);
    vi.doUnmock('../../env.js');
    vi.doUnmock('../../logger.js');
  });
});
