import sharp from 'sharp';
import type { Context } from 'hono';
import { env } from '../env.js';
import { logger } from '../logger.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DIMENSION = 2000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CACHE_BYTES = 100 * 1024 * 1024; // 100 MB

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

  // Sort entries by lastUsed ascending (oldest first)
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

  const urlError = validateImageUrl(imageUrl);
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
      signal: AbortSignal.timeout(10_000),
    });

    if (!upstream.ok) {
      return c.json({ code: 'UPSTREAM_ERROR', message: `Upstream returned ${upstream.status}` }, 502);
    }

    const contentLength = parseInt(upstream.headers.get('Content-Length') ?? '0', 10);
    if (contentLength > MAX_IMAGE_BYTES) {
      return c.json({ code: 'IMAGE_TOO_LARGE', message: 'Image exceeds 10 MB limit' }, 413);
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      return c.json({ code: 'IMAGE_TOO_LARGE', message: 'Image exceeds 10 MB limit' }, 413);
    }

    let pipeline = sharp(buffer);

    if (width > 0 || height > 0) {
      pipeline = pipeline.resize(width || null, height || null, { fit: 'inside', withoutEnlargement: true });
    }

    const { data, info } = await pipeline.jpeg({ quality }).toBuffer({ resolveWithObject: true });
    const mimeType = 'image/jpeg';
    const output = new Uint8Array(data);

    evictLruUntilFits(output.byteLength);
    cache.set(key, {
      data: output,
      mimeType,
      cachedAt: Date.now(),
      lastUsed: Date.now(),
      sizeBytes: output.byteLength,
    });
    totalCacheBytes += output.byteLength;

    log.debug({ url: imageUrl, width: info.width, height: info.height, bytes: output.byteLength }, 'Image processed');
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
 * Validates that the given URL is safe to proxy:
 * - Must be https: (or http: only in development)
 * - Must not target private/loopback IP ranges or localhost
 * - If IMAGE_PROXY_ALLOWED_HOSTS is configured, hostname must be in the allowlist
 *
 * Returns an error string if invalid, or null if valid.
 */
function validateImageUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'Invalid URL';
  }

  const { protocol, hostname } = parsed;

  // Require HTTPS in production; allow HTTP only in development
  if (protocol !== 'https:' && !(env.NODE_ENV === 'development' && protocol === 'http:')) {
    return 'Only HTTPS URLs are allowed';
  }

  // Block loopback and private IP ranges (SSRF prevention)
  const privatePatterns = [
    /^localhost$/i,
    /^127\.\d+\.\d+\.\d+$/,
    /^10\.\d+\.\d+\.\d+$/,
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
    /^192\.168\.\d+\.\d+$/,
    /^169\.254\.\d+\.\d+$/, // link-local
    /^::1$/,
    /^fc[0-9a-f]{2}:/i, // IPv6 unique local
    /^\[.*\]$/, // any bracketed IPv6 — conservative block
  ];
  if (privatePatterns.some((re) => re.test(hostname))) {
    return 'Private and loopback addresses are not allowed';
  }

  // If an allowlist is configured, enforce it
  if (env.IMAGE_PROXY_ALLOWED_HOSTS !== undefined) {
    const allowed = env.IMAGE_PROXY_ALLOWED_HOSTS.split(',').map((h) => h.trim().toLowerCase());
    if (!allowed.includes(hostname.toLowerCase())) {
      return `Host "${hostname}" is not in the allowed list`;
    }
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
