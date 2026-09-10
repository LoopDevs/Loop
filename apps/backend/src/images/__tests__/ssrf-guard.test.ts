import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';
import type { LookupAddress, LookupOptions } from 'node:dns';

// IP-range defence only runs in production (ADR 050: local CTX file hosts work in dev).
const { configState } = vi.hoisted(() => ({
  configState: { env: 'production' as 'development' | 'production' | 'test' },
}));
vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return { ...actual.config, env: configState.env };
    },
  };
});

const mockDnsLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: mockDnsLookup }));

import { validateResolvedImageUrl, isPrivateOrReservedIp, ssrfSafeLookup } from '../ssrf-guard.js';

beforeEach(() => {
  mockDnsLookup.mockReset();
  configState.env = 'production';
});

interface LookupOutcome {
  err: Error | null;
  address: string | LookupAddress[];
  family?: number | undefined;
}
function callLookup(host: string, options: LookupOptions): Promise<LookupOutcome> {
  return new Promise((resolve) => {
    ssrfSafeLookup(host, options, (err, address, family) =>
      resolve({ err: err ?? null, address, family }),
    );
  });
}

describe('isPrivateOrReservedIp — NAT64 / 6to4 embedded IPv4 (SEC-SSRF-nat64)', () => {
  // Decodes embedded IPv4 to catch internal hosts hidden in public-looking v6 literals.
  it('rejects NAT64 (64:ff9b::/96) embedding the cloud-metadata IP', () => {
    expect(isPrivateOrReservedIp('64:ff9b::a9fe:a9fe')).toBe(true);
  });

  it('rejects NAT64 embedding loopback (127.0.0.1) in hex form', () => {
    expect(isPrivateOrReservedIp('64:ff9b::7f00:1')).toBe(true);
  });

  it('rejects NAT64 embedding a private IPv4 in dotted form', () => {
    // WHATWG-normalises to 64:ff9b::c0a8:1 — must still decode + reject.
    expect(isPrivateOrReservedIp('64:ff9b::192.168.0.1')).toBe(true);
  });

  it('rejects 6to4 (2002::/16) embedding an RFC1918 IPv4', () => {
    expect(isPrivateOrReservedIp('2002:c0a8:101::')).toBe(true);
  });

  it('rejects 6to4 embedding the cloud-metadata IP', () => {
    expect(isPrivateOrReservedIp('2002:a9fe:a9fe::')).toBe(true);
  });

  it('still ALLOWS a NAT64/6to4 address whose embedded IPv4 is public (range-check, not blanket-block)', () => {
    expect(isPrivateOrReservedIp('64:ff9b::5db8:d822')).toBe(false);
    expect(isPrivateOrReservedIp('2002:5db8:d822::')).toBe(false);
  });

  it('does not over-block ordinary public IPv6 (no NAT64/6to4 prefix)', () => {
    expect(isPrivateOrReservedIp('2001:4860:4860::8888')).toBe(false);
  });

  it('sanity: existing v4/v6 ranges still classified correctly', () => {
    expect(isPrivateOrReservedIp('10.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('fe80::1')).toBe(true);
    expect(isPrivateOrReservedIp('93.184.216.34')).toBe(false);
  });
});

describe('ssrfSafeLookup — connect-time rebind defence (SEC-SSRF-allowlist)', () => {
  // Refuses private answers at connect time to prevent DNS-rebind attacks.
  it('fails the lookup when the host resolves to a private/metadata IP (rebind)', async () => {
    mockDnsLookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    const { err, address } = await callLookup('rebind.evil.com', { all: true });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain('169.254.169.254');
    expect(address).toBe('');
  });

  it('fails the lookup when the host resolves to a NAT64-embedded metadata IPv6 (rebind + nat64)', async () => {
    mockDnsLookup.mockResolvedValueOnce([{ address: '64:ff9b::a9fe:a9fe', family: 6 }]);
    const { err } = await callLookup('rebind6.evil.com', { all: true });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/private\/reserved/);
  });

  it('fails when ANY of several resolved addresses is private (mixed A records)', async () => {
    mockDnsLookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    const { err } = await callLookup('mixed.evil.com', { all: true });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain('10.0.0.5');
  });

  it('hands back the addresses when the host resolves to a public IP (all:true)', async () => {
    mockDnsLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const { err, address } = await callLookup('cdn.example.com', { all: true });
    expect(err).toBeNull();
    expect(address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('hands back a single address + family for a non-all lookup', async () => {
    mockDnsLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const { err, address, family } = await callLookup('cdn.example.com', { all: false });
    expect(err).toBeNull();
    expect(address).toBe('93.184.216.34');
    expect(family).toBe(4);
  });

  it('propagates a resolution failure as a lookup error', async () => {
    mockDnsLookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const { err } = await callLookup('nope.invalid', { all: true });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain('ENOTFOUND');
  });
});

describe('validateResolvedImageUrl — production pre-flight defence (ADR 050)', () => {
  it('rejects a hostname that resolves to the metadata IP even with no allowlist', async () => {
    mockDnsLookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    const err = await validateResolvedImageUrl('https://metadata.evil.com/latest/meta-data/');
    expect(err).toContain('Private and loopback');
  });

  it('rejects a NAT64-embedded metadata IPv6 literal with no allowlist (SEC-SSRF-nat64)', async () => {
    const err = await validateResolvedImageUrl('https://[64:ff9b::a9fe:a9fe]/x.png');
    expect(err).toContain('Private and loopback');
    expect(mockDnsLookup).not.toHaveBeenCalled();
  });

  it('rejects a 6to4 RFC1918 literal with no allowlist', async () => {
    const err = await validateResolvedImageUrl('https://[2002:c0a8:101::]/x.png');
    expect(err).toContain('Private and loopback');
  });

  it('allows a public host (control) with no allowlist', async () => {
    mockDnsLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const err = await validateResolvedImageUrl('https://cdn.example.com/logo.png');
    expect(err).toBeNull();
  });
});

describe('validateResolvedImageUrl — permissive outside production (ADR 050)', () => {
  it('allows loopback/http URLs in development (local CTX file hosts)', async () => {
    configState.env = 'development';
    expect(await validateResolvedImageUrl('http://localhost:7777/files/abc/download')).toBeNull();
    expect(await validateResolvedImageUrl('http://127.0.0.1:9091/img.png')).toBeNull();
    expect(mockDnsLookup).not.toHaveBeenCalled();
  });

  it('still rejects non-http(s) schemes in every environment', async () => {
    configState.env = 'development';
    expect(await validateResolvedImageUrl('file:///etc/passwd')).toContain('HTTP(S)');
    expect(await validateResolvedImageUrl('not a url')).toBe('Invalid URL');
  });

  it('rejects plain http in production', async () => {
    configState.env = 'production';
    expect(await validateResolvedImageUrl('http://cdn.example.com/logo.png')).toContain('HTTPS');
  });
});
