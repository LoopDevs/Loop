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
});
