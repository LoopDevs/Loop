/**
 * SSRF guard for the image proxy.
 *
 * Lifted out of `apps/backend/src/images/proxy.ts`. Three pure
 * helpers that share one concern — validating that a remote URL
 * is safe to proxy:
 *
 *   - `validateImageUrl(rawUrl)` — protocol check, allowlist
 *     check, hostname resolution, IP-range check across every
 *     resolved address.
 *   - `isPrivateOrReservedIp(ip)` — IPv4 + IPv6 range check,
 *     covering RFC 1918 private, loopback, link-local, CGNAT,
 *     reserved, multicast, plus IPv4-mapped IPv6 forms.
 *   - `extractEmbeddedIPv4(ipv6Lower)` — pulls the IPv4 out of
 *     `::ffff:a.b.c.d` / `::ffff:XXXX:YYYY` so the IPv4 range
 *     check can run.
 *
 * Pulled out to give the SSRF-defense logic its own focused
 * home — separate from the proxy\'s caching / fetch-with-limit
 * / sharp-resize plumbing in the parent file. The known
 * DNS-rebinding TOCTOU limitation is documented on
 * `validateImageUrl` itself; the practical mitigation
 * (`IMAGE_PROXY_ALLOWED_HOSTS`) is enforced inline.
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { env } from '../env.js';

/**
 * Validates that the given URL is safe to proxy:
 * - Must be https: (or http: only in development)
 * - If IMAGE_PROXY_ALLOWED_HOSTS is configured, hostname must be in the allowlist
 * - Resolves hostname via DNS and rejects if any resolved address is private,
 *   loopback, link-local, CGNAT, or multicast (SSRF / DNS-rebinding defense)
 *
 * Returns an error string if invalid, or null if valid.
 *
 * KNOWN LIMITATION — DNS rebinding TOCTOU.
 * We validate the resolved IPs here, but `fetch()` below performs its own
 * DNS lookup that we do not control. An attacker-controlled DNS server can
 * return a public IP to our validation and a private IP to the subsequent
 * fetch. The practical mitigation is `IMAGE_PROXY_ALLOWED_HOSTS`: when set,
 * only operator-trusted hostnames can be resolved at all. Untrusted input
 * without an allowlist remains exposed to this class of attack; a tighter
 * fix would require a custom undici `dispatcher.connect` that reuses the
 * already-resolved IP with the expected `Host` header.
 */
export async function validateImageUrl(rawUrl: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'Invalid URL';
  }

  const { protocol, hostname } = parsed;

  if (protocol !== 'https:' && !(env.NODE_ENV === 'development' && protocol === 'http:')) {
    return 'Only HTTPS URLs are allowed';
  }

  if (env.IMAGE_PROXY_ALLOWED_HOSTS !== undefined) {
    const allowed = env.IMAGE_PROXY_ALLOWED_HOSTS.split(',').map((h) => h.trim().toLowerCase());
    if (!allowed.includes(hostname.toLowerCase())) {
      return `Host "${hostname}" is not in the allowed list`;
    }
  }

  // URL hostnames for IPv6 literals are returned bracketed; strip them.
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  if (host.toLowerCase() === 'localhost') {
    return 'Private and loopback addresses are not allowed';
  }

  // Resolve to one or more IPs. If the hostname is already an IP literal,
  // `net.isIP` lets us short-circuit without a DNS roundtrip.
  let addresses: string[];
  if (net.isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      const results = await lookup(host, { all: true });
      addresses = results.map((r) => r.address);
    } catch {
      return 'Unable to resolve hostname';
    }
    if (addresses.length === 0) {
      return 'Unable to resolve hostname';
    }
  }

  for (const addr of addresses) {
    if (isPrivateOrReservedIp(addr)) {
      return 'Private and loopback addresses are not allowed';
    }
  }

  return null;
}

/**
 * Returns true if `ip` belongs to a range we must not proxy to:
 * loopback, private, link-local, CGNAT, reserved, multicast, unspecified,
 * including IPv4-mapped IPv6 forms that would otherwise bypass IPv4 checks.
 */
function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    // noUncheckedIndexedAccess: `parts.length === 4` has already been verified above.
    const a = parts[0] as number;
    const b = parts[1] as number;
    if (a === 0) return true; // 0.0.0.0/8 — "this network"; 0.0.0.0 often routes to localhost
    if (a === 10) return true; // RFC 1918
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
    if (a === 192 && b === 168) return true; // RFC 1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC 6598)
    if (a >= 224) return true; // multicast (224/4), reserved (240/4), broadcast
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;

    // IPv4-embedded forms. The WHATWG URL parser normalizes `::ffff:127.0.0.1`
    // to its hex form `::ffff:7f00:1`, so we must handle both.
    const embeddedV4 = extractEmbeddedIPv4(lower);
    if (embeddedV4 !== null) return isPrivateOrReservedIp(embeddedV4);

    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
    if (lower.startsWith('ff')) return true; // ff00::/8 multicast
    return false;
  }
  return true;
}

/**
 * Extracts the embedded IPv4 from IPv4-mapped (::ffff:a.b.c.d / ::ffff:XXXX:YYYY)
 * or IPv4-compatible (::a.b.c.d) IPv6 forms. Returns null if not embedded.
 */
function extractEmbeddedIPv4(ipv6Lower: string): string | null {
  const dotted = ipv6Lower.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1] !== undefined) return dotted[1];
  const hex = ipv6Lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const h1 = parseInt(hex[1], 16);
    const h2 = parseInt(hex[2], 16);
    return `${(h1 >> 8) & 0xff}.${h1 & 0xff}.${(h2 >> 8) & 0xff}.${h2 & 0xff}`;
  }
  return null;
}
