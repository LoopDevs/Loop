import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';
import type { Config } from '../../config/index.js';

/**
 * `getEmailProvider()` reads the validated `config.email` union, so
 * these tests drive it by mutating a hoisted override that the config
 * mock re-reads on every access (the provider itself is cached, hence
 * the `__resetEmailProviderForTests()` calls).
 *
 * The old "unknown provider" / "resend without an API key" cases are
 * gone: the `email` section is a discriminated union now, so neither
 * shape parses. Their coverage lives in `__tests__/config.test.ts`.
 */
const CONSOLE_EMAIL: Config['email'] = {
  provider: 'console',
  from: { address: 'noreply@loopfinance.io', name: 'Loop' },
};

const RESEND_EMAIL: Config['email'] = {
  provider: 'resend',
  apiKey: 're_test_xxxxxxxxxxxxxxxx',
  from: { address: 'noreply@loopfinance.io', name: 'Loop' },
};

const { configState } = vi.hoisted(() => ({
  configState: {
    env: 'test' as 'development' | 'production' | 'test',
    email: {
      provider: 'console',
      from: { address: 'noreply@loopfinance.io', name: 'Loop' },
    } as Config['email'],
    sentryDsn: undefined as string | undefined,
  },
}));

vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        env: configState.env,
        email: configState.email,
        observability: {
          ...actual.config.observability,
          sentry: { ...actual.config.observability.sentry, dsn: configState.sentryDsn },
        },
      };
    },
  };
});

import { getEmailProvider, __resetEmailProviderForTests } from '../email.js';

beforeEach(() => {
  __resetEmailProviderForTests();
  configState.env = 'test';
  configState.email = CONSOLE_EMAIL;
  configState.sentryDsn = undefined;
});

afterEach(() => {
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

  it('honours an explicit provider: console in non-production', () => {
    configState.email = CONSOLE_EMAIL;
    const p = getEmailProvider();
    expect(p.name).toBe('console');
  });

  // A2-571: the console stub logs plaintext OTPs, so it must never run
  // in production — whether it arrived as the schema default or as an
  // explicit `provider: console`.
  it('A2-571: refuses provider: console in production (stub leaks plaintext OTPs)', () => {
    configState.env = 'production';
    configState.email = CONSOLE_EMAIL;
    expect(() => getEmailProvider()).toThrow(/not permitted in production/);
  });

  it('A2-571: refuses the defaulted console provider in production', () => {
    configState.env = 'production';
    expect(() => getEmailProvider()).toThrow(/not permitted in production/);
  });

  it('returns the resend provider for provider: resend', () => {
    configState.email = RESEND_EMAIL;
    const p = getEmailProvider();
    expect(p.name).toBe('resend');
  });
});

describe('ResendEmailProvider.sendOtpEmail', () => {
  beforeEach(() => {
    configState.email = RESEND_EMAIL;
    __resetEmailProviderForTests();
  });

  it('POSTs to Resend with bearer auth, default from, code in body only (never the subject)', async () => {
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
    // NTF-18: the subject leaks into lock-screen / push-notification
    // previews, so the OTP code must never appear there — only in the
    // body, which requires opening the mail.
    expect(body.subject).toBe('Your Loop verification code');
    expect(body.subject).not.toContain('654321');
    expect(body.text).toContain('654321');
    expect(body.html).toContain('654321');
    fetchSpy.mockRestore();
  });

  it('omits reply_to from the body when email.replyTo is unset', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await getEmailProvider().sendOtpEmail({
      to: 'a@b.com',
      code: '222222',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // The key itself must be absent — sending `reply_to: null` makes
    // some inbox clients render "(no reply address)" instead of
    // falling back to the From address.
    expect('reply_to' in body).toBe(false);
    fetchSpy.mockRestore();
  });

  it('sends reply_to in the body when email.replyTo is set', async () => {
    configState.email = { ...RESEND_EMAIL, replyTo: 'hello@loopfinance.io' };
    __resetEmailProviderForTests();
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await getEmailProvider().sendOtpEmail({
      to: 'a@b.com',
      code: '333333',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { reply_to?: string };
    expect(body.reply_to).toBe('hello@loopfinance.io');
    fetchSpy.mockRestore();
  });

  it('honours email.from.address + email.from.name overrides', async () => {
    configState.email = {
      ...RESEND_EMAIL,
      from: { address: 'auth@loopfinance.io', name: 'Loop Finance' },
    };
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
  // checking observability.sentry.dsn at the call site; raw code only
  // in the no-Sentry (default dev) branch.
  it('A2-1612: includes the raw code when the Sentry DSN is unset', async () => {
    vi.resetModules();
    configState.sentryDsn = undefined;
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
    // Logged under `revealedDevOtpCode` — a key deliberately OUTSIDE
    // logger.ts's REDACT_PATHS (`code` is redacted even in dev), so the
    // console stub's grab-the-OTP-from-the-log purpose actually works.
    expect(loggerCalls[0]![0]['revealedDevOtpCode']).toBe('123456');
    expect(loggerCalls[0]![0]['code']).toBeUndefined();
    expect(loggerCalls[0]![1]).toMatch(/dev-only/);
    vi.doUnmock('../../logger.js');
  });

  it('A2-1612: redacts the code when the Sentry DSN is set (Sentry pre-redaction protection)', async () => {
    vi.resetModules();
    configState.sentryDsn = 'https://x@o.ingest.sentry.io/42';
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
    vi.doUnmock('../../logger.js');
  });
});
