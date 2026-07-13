import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LookupAddress, LookupOptions } from 'node:dns';

// Mirror proxy.test.ts's env/dns mocking so the guard can be exercised in
// isolation. Default: allowlist OFF (undefined) and production mode — the
// point of these tests is that the IP-range defence holds with no allowlist.
const mockEnv = vi.hoisted(() => {
  const obj: Record<string, unknown> = { NODE_ENV: 'production' };
  return obj;
});
vi.mock('../../env.js', () => ({ env: mockEnv }));

const mockDnsLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: mockDnsLookup }));

import { validateImageUrl, isPrivateOrReservedIp, ssrfSafeLookup } from '../ssrf-guard.js';

beforeEach(() => {
  mockDnsLookup.mockReset();
  mockEnv.NODE_ENV = 'production';
  delete mockEnv.IMAGE_PROXY_ALLOWED_HOSTS;
});

// Promise wrapper around the node `LookupFunction` callback so tests can
// await the resolver's decision.
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
  // Each of these v6 literals looks like an ordinary public address but,
  // once the embedded IPv4 is decoded, targets an internal host. Before the
  // fix the guard returned false for all of them → SSRF to internal IPv4.
  it('rejects NAT64 (64:ff9b::/96) embedding the cloud-metadata IP', () => {
    // 64:ff9b::a9fe:a9fe decodes to 169.254.169.254
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
    // 2002:c0a8:101:: decodes to 192.168.1.1
    expect(isPrivateOrReservedIp('2002:c0a8:101::')).toBe(true);
  });

  it('rejects 6to4 embedding the cloud-metadata IP', () => {
    // 2002:a9fe:a9fe:: decodes to 169.254.169.254
    expect(isPrivateOrReservedIp('2002:a9fe:a9fe::')).toBe(true);
  });

  it('still ALLOWS a NAT64/6to4 address whose embedded IPv4 is public (range-check, not blanket-block)', () => {
    // 93.184.216.34 (example.com) embedded — legitimately public.
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
  // This is the resolver Node's socket calls to decide the address the
  // request ACTUALLY connects to. A DNS-rebind resolver answers public
  // during pre-flight and private at connect time; this function is the one
  // the connection uses, so it must refuse the private answer.
  it('fails the lookup when the host resolves to a private/metadata IP (rebind)', async () => {
    mockDnsLookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    const { err, address } = await callLookup('rebind.evil.com', { all: true });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain('169.254.169.254');
    // Must NOT have handed back a connectable address.
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

describe('validateImageUrl — pre-flight defence with the allowlist OFF', () => {
  it('rejects a hostname that resolves to the metadata IP even with no allowlist', async () => {
    // Allowlist unset (deleted in beforeEach). A public-looking host that
    // resolves to 169.254.169.254 must still be rejected.
    mockDnsLookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    const err = await validateImageUrl('https://metadata.evil.com/latest/meta-data/');
    expect(err).toContain('Private and loopback');
  });

  it('rejects a NAT64-embedded metadata IPv6 literal with no allowlist (SEC-SSRF-nat64)', async () => {
    const err = await validateImageUrl('https://[64:ff9b::a9fe:a9fe]/x.png');
    expect(err).toContain('Private and loopback');
    // IP literal → no DNS roundtrip needed.
    expect(mockDnsLookup).not.toHaveBeenCalled();
  });

  it('rejects a 6to4 RFC1918 literal with no allowlist', async () => {
    const err = await validateImageUrl('https://[2002:c0a8:101::]/x.png');
    expect(err).toContain('Private and loopback');
  });

  it('allows a public host (control) with no allowlist', async () => {
    mockDnsLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const err = await validateImageUrl('https://cdn.example.com/logo.png');
    expect(err).toBeNull();
  });
});
