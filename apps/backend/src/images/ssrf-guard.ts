// SSRF guard for the image proxy — ADR 050
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import type { LookupFunction } from 'node:net';
import { config } from '../config/index.js';

// Pre-flight check: validates CTX-supplied URLs (defense-in-depth per ADR 050).
// Closes DNS-rebinding TOCTOU via ssrfSafeLookup at the connection layer.
export async function validateResolvedImageUrl(rawUrl: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'Invalid URL';
  }

  const { protocol, hostname } = parsed;

  if (protocol !== 'https:' && protocol !== 'http:') {
    return 'Only HTTP(S) URLs are supported';
  }

  if (config.env !== 'production') return null;

  if (protocol !== 'https:') {
    return 'Only HTTPS URLs are allowed';
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

// SSRF-safe DNS resolver: re-checks range at connection time to prevent DNS-rebinding.
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

// Checks IPv4/IPv6 ranges including NAT64/6to4 embedded IPv4s to prevent bypass.
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

// Expands IPv6 to 8 groups, handling `::` and trailing dotted-quad.
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

// Extracts embedded IPv4 from NAT64 (64:ff9b::/96) or 6to4 (2002::/16).
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

// Extracts embedded IPv4 from IPv4-mapped (::ffff:...) or IPv4-compatible (::...) forms.
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
