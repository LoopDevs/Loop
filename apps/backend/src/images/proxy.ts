import { lookup } from 'node:dns/promises';
import net from 'node:net';
import sharp from 'sharp';
import type { Context } from 'hono';
import { env } from '../env.js';
import { logger } from '../logger.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DIMENSION = 2000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CACHE_BYTES = 100 * 1024 * 1024; // 100 MB
const FETCH_TIMEOUT_MS = 10_000;

interface CacheEntry {
  data: Uint8Array;
  mimeType: string;
  cachedAt: number;
  lastUsed: number;
  sizeBytes: number;
}

const cache = new Map<string, CacheEntry>();
let totalCacheBytes = 0;

function cacheKey(url: string, width: number, height: number, quality: number): string {
  return `${url}|${width}|${height}|${quality}`;
}

function evictLruUntilFits(requiredBytes: number): void {
  if (totalCacheBytes + requiredBytes <= MAX_CACHE_BYTES) return;

  const entries = [...cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);

  for (const [key, entry] of entries) {
    if (totalCacheBytes + requiredBytes <= MAX_CACHE_BYTES) break;
    cache.delete(key);
    totalCacheBytes -= entry.sizeBytes;
  }
}

/**
 * GET /api/image
 *
 * Fetches a remote image, resizes it with sharp, caches the result, and
 * returns it with appropriate Content-Type and Cache-Control headers.
 *
 * Query params:
 *   url      — remote image URL (required)
 *   width    — target width in px (optional, max 2000)
 *   height   — target height in px (optional, max 2000)
 *   quality  — JPEG quality 1–100 (optional, default 80)
 */
export async function imageProxyHandler(c: Context): Promise<Response> {
  const log = logger.child({ handler: 'image-proxy' });

  const imageUrl = c.req.query('url');
  if (!imageUrl) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'url is required' }, 400);
  }

  const urlError = await validateImageUrl(imageUrl);
  if (urlError !== null) {
    log.warn({ url: imageUrl, reason: urlError }, 'Image proxy URL rejected');
    return c.json({ code: 'VALIDATION_ERROR', message: urlError }, 400);
  }

  const width = clampDimension(parseInt(c.req.query('width') ?? '0', 10));
  const height = clampDimension(parseInt(c.req.query('height') ?? '0', 10));
  const quality = clampQuality(parseInt(c.req.query('quality') ?? '80', 10));

  const key = cacheKey(imageUrl, width, height, quality);

  const cached = cache.get(key);
  if (cached !== undefined && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    cached.lastUsed = Date.now();
    return imageResponse(cached.data, cached.mimeType);
  }

  try {
    const upstream = await fetch(imageUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'manual',
    });

    // Reject redirects — following them would re-introduce SSRF risk by
    // letting an allowed upstream point at a private IP.
    if (upstream.status >= 300 && upstream.status < 400) {
      return c.json(
        { code: 'UPSTREAM_REDIRECT', message: 'Redirects from upstream are not allowed' },
        502,
      );
    }

    if (!upstream.ok) {
      return c.json(
        { code: 'UPSTREAM_ERROR', message: `Upstream returned ${upstream.status}` },
        502,
      );
    }

    const contentType = (upstream.headers.get('Content-Type') ?? '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      return c.json({ code: 'NOT_AN_IMAGE', message: 'Upstream response is not an image' }, 502);
    }

    const declaredLength = parseInt(upstream.headers.get('Content-Length') ?? '0', 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
      return c.json({ code: 'IMAGE_TOO_LARGE', message: 'Image exceeds 10 MB limit' }, 413);
    }

    const buffer = await readBodyWithLimit(upstream, MAX_IMAGE_BYTES);
    if (buffer === null) {
      return c.json({ code: 'IMAGE_TOO_LARGE', message: 'Image exceeds 10 MB limit' }, 413);
    }

    let pipeline = sharp(buffer);

    if (width > 0 || height > 0) {
      pipeline = pipeline.resize(width || null, height || null, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    const { data, info } = await pipeline.jpeg({ quality }).toBuffer({ resolveWithObject: true });
    const mimeType = 'image/jpeg';
    const output = new Uint8Array(data);

    if (output.byteLength <= MAX_CACHE_BYTES) {
      evictLruUntilFits(output.byteLength);
      cache.set(key, {
        data: output,
        mimeType,
        cachedAt: Date.now(),
        lastUsed: Date.now(),
        sizeBytes: output.byteLength,
      });
      totalCacheBytes += output.byteLength;
    }

    log.debug(
      { url: imageUrl, width: info.width, height: info.height, bytes: output.byteLength },
      'Image processed',
    );
    return imageResponse(output, mimeType);
  } catch (err) {
    log.error({ err, url: imageUrl }, 'Image proxy error');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to process image' }, 500);
  }
}

/** Removes entries older than CACHE_TTL_MS. Call periodically. */
export function evictExpiredImageCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.cachedAt > CACHE_TTL_MS) {
      cache.delete(key);
      totalCacheBytes -= entry.sizeBytes;
    }
  }
}

function imageResponse(data: Uint8Array, mimeType: string): Response {
  return new Response(data, {
    headers: {
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=604800, immutable',
    },
  });
}

/**
 * Reads the response body into a Buffer, aborting if the running byte total
 * exceeds `limit`. Returns null if the limit is exceeded. Streaming read
 * ensures we do not buffer a multi-GB response into memory just to reject it.
 */
async function readBodyWithLimit(res: Response, limit: number): Promise<Buffer | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.byteLength > limit ? null : buf;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/**
 * Validates that the given URL is safe to proxy:
 * - Must be https: (or http: only in development)
 * - If IMAGE_PROXY_ALLOWED_HOSTS is configured, hostname must be in the allowlist
 * - Resolves hostname via DNS and rejects if any resolved address is private,
 *   loopback, link-local, CGNAT, or multicast (SSRF / DNS-rebinding defense)
 *
 * Returns an error string if invalid, or null if valid.
 */
async function validateImageUrl(rawUrl: string): Promise<string | null> {
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

function clampDimension(v: number): number {
  if (isNaN(v) || v <= 0) return 0;
  return Math.min(v, MAX_DIMENSION);
}

function clampQuality(v: number): number {
  if (isNaN(v)) return 80;
  return Math.max(1, Math.min(v, 100));
}
