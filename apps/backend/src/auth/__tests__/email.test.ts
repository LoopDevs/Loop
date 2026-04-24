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
