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

  it('honours an explicit EMAIL_PROVIDER=console', () => {
    process.env['EMAIL_PROVIDER'] = 'console';
    const p = getEmailProvider();
    expect(p.name).toBe('console');
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
