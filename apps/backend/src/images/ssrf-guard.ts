/**
 * SSRF guard for the image proxy.
 *
 * Lifted out of `apps/backend/src/images/proxy.ts`. The helpers
 * share one concern — validating that a remote URL is safe to proxy:
 *
 *   - `validateImageUrl(rawUrl)` — protocol check, allowlist
 *     check, hostname resolution, IP-range check across every
 *     resolved address (the pre-flight check).
 *   - `ssrfSafeLookup(hostname, …)` — the connecting socket's DNS
 *     resolver for the *actual* fetch: it re-range-checks the address
 *     the connection will use, so a DNS-rebind between the pre-flight
 *     check and the fetch cannot land on an internal target.
 *   - `isPrivateOrReservedIp(ip)` — IPv4 + IPv6 range check,
 *     covering RFC 1918 private, loopback, link-local, CGNAT,
 *     reserved, multicast, IPv4-mapped IPv6 forms, plus NAT64
 *     (64:ff9b::/96) and 6to4 (2002::/16) addresses whose embedded
 *     IPv4 falls in one of those ranges.
 *   - `extractEmbeddedIPv4(ipv6Lower)` — pulls the IPv4 out of
 *     `::ffff:a.b.c.d` / `::ffff:XXXX:YYYY` so the IPv4 range
 *     check can run.
 *
 * Pulled out to give the SSRF-defense logic its own focused
 * home — separate from the proxy\'s caching / fetch-with-limit
 * / sharp-resize plumbing in the parent file. The DNS-rebinding
 * TOCTOU gap that used to be a documented limitation is now closed
 * by `ssrfSafeLookup` (wired into the proxy's fetch as the socket's
 * `lookup`); `IMAGE_PROXY_ALLOWED_HOSTS` remains a defence-in-depth
 * layer on top, not the only mitigation.
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import type { LookupFunction } from 'node:net';
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
 * This is the pre-flight check: it rejects obviously-bad URLs before any
 * socket is opened. It does NOT, on its own, close the DNS-rebinding
 * TOCTOU window — an attacker-run resolver can answer with a public IP
 * here and a private IP to the fetch's own later lookup. That window is
 * closed at the connection layer by `ssrfSafeLookup`, which the proxy
 * wires in as the connecting socket's `lookup`, so the address the
 * request actually connects to is range-checked too. Both layers run
 * regardless of whether `IMAGE_PROXY_ALLOWED_HOSTS` is configured.
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
 * SSRF-safe DNS resolver for the image proxy's actual fetch — wired in
 * as the connecting socket's `lookup` (see `proxy.ts`).
 *
 * `validateImageUrl` above range-checks the IPs it resolves, but a plain
 * `fetch()` performs its OWN later DNS lookup that we don't control: an
 * attacker-run resolver can answer with a public IP during pre-flight and
 * a private one for the connection (DNS-rebinding TOCTOU). Because Node's
 * socket calls THIS function to resolve the host it is about to connect
 * to, doing the range check here means the address the request actually
 * reaches is validated — closing the rebind gap even when the host
 * allowlist is disabled. If any resolved address is private/reserved we
 * fail the lookup (the connection never opens) rather than hand it back.
 *
 * IP-literal hosts skip DNS entirely (Node connects directly), so this is
 * never called for them; `validateImageUrl` already range-checks literals
 * before the fetch is attempted.
 */
export const ssrfSafeLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true, family: options.family, hints: options.hints })
    .then((results) => {
      const first = results[0];
      if (first === undefined) {
        callback(new Error(`SSRF guard: ${hostname} did not resolve`), '');
        return;
      }
      const blocked = results.find((r) => isPrivateOrReservedIp(r.address));
      if (blocked !== undefined) {
        callback(
          new Error(
            `SSRF guard: refusing to connect to ${hostname} — resolves to private/reserved address ${blocked.address}`,
          ),
          '',
        );
        return;
      }
      if (options.all === true) {
        callback(null, results);
      } else {
        callback(null, first.address, first.family);
      }
    })
    .catch((err: unknown) => {
      callback(err instanceof Error ? err : new Error(String(err)), '');
    });
};

/**
 * Returns true if `ip` belongs to a range we must not proxy to:
 * loopback, private, link-local, CGNAT, reserved, multicast, unspecified,
 * including IPv4-mapped IPv6 forms, and NAT64 / 6to4 addresses whose
 * embedded IPv4 falls in one of those ranges (which would otherwise bypass
 * the IPv4 checks entirely).
 *
 * Exported so the connection-layer resolver (`ssrfSafeLookup`) and its
 * tests can share exactly this range logic.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
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

    // NAT64 (RFC 6052 well-known prefix 64:ff9b::/96) and 6to4 (RFC 3056,
    // 2002::/16) both carry an embedded IPv4 that the raw v6 range checks
    // below miss: a public-looking literal like `64:ff9b::a9fe:a9fe` or
    // `2002:a9fe:a9fe::` decodes to 169.254.169.254 (cloud metadata), and
    // `64:ff9b::7f00:1` to 127.0.0.1. Decode the embedded v4 and range-check
    // it so such an address can't smuggle a private/reserved target past the
    // guard. A NAT64/6to4 address whose embedded v4 is public stays allowed.
    const embeddedTranslatedV4 = extractNat64OrSixToFourIPv4(lower);
    if (embeddedTranslatedV4 !== null && isPrivateOrReservedIp(embeddedTranslatedV4)) return true;

    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
    if (lower.startsWith('ff')) return true; // ff00::/8 multicast
    return false;
  }
  return true;
}

/**
 * Expands an IPv6 string to its eight 16-bit groups, handling `::`
 * compression and a trailing embedded dotted-quad (`…:a.b.c.d`). Returns
 * null if the input is not a well-formed IPv6 literal.
 */
function expandIpv6(ipv6Lower: string): number[] | null {
  if (!net.isIPv6(ipv6Lower)) return null;
  let s = ipv6Lower;

  // Fold a trailing dotted-quad (…:a.b.c.d) into its two hex groups so the
  // rest of the parse only has to deal with `:`-separated hextets.
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4 !== null && v4.index !== undefined) {
    const quad = v4[1]?.split('.').map((p) => Number(p)) ?? [];
    if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const q0 = quad[0] as number;
    const q1 = quad[1] as number;
    const q2 = quad[2] as number;
    const q3 = quad[3] as number;
    s = s.slice(0, v4.index) + `${((q0 << 8) | q1).toString(16)}:${((q2 << 8) | q3).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((h) => parseInt(h, 16));
  const head = toGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? toGroups(halves[1] ?? '') : [];

  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  return groups;
}

/**
 * If `ipv6Lower` is a NAT64 well-known-prefix (64:ff9b::/96) or a 6to4
 * (2002::/16) address, returns the dotted IPv4 it embeds; otherwise null.
 * NAT64 carries the v4 in the low 32 bits; 6to4 in bits 16-47.
 */
function extractNat64OrSixToFourIPv4(ipv6Lower: string): string | null {
  const groups = expandIpv6(ipv6Lower);
  if (groups === null) return null;
  // expandIpv6 guarantees exactly 8 in-range groups; the casts mirror the
  // noUncheckedIndexedAccess idiom used for `parts` in the IPv4 branch.
  const g = (i: number): number => groups[i] as number;
  const toDotted = (hi: number, lo: number): string =>
    `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;

  // NAT64 well-known prefix 64:ff9b:0:0:0:0::/96 — v4 in the final two groups.
  if (g(0) === 0x0064 && g(1) === 0xff9b && g(2) === 0 && g(3) === 0 && g(4) === 0 && g(5) === 0) {
    return toDotted(g(6), g(7));
  }
  // 6to4 2002::/16 — v4 in groups 1-2.
  if (g(0) === 0x2002) {
    return toDotted(g(1), g(2));
  }
  return null;
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
