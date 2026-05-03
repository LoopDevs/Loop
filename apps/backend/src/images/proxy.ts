import sharp from 'sharp';
import type { Context } from 'hono';
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
  const mode = c.req.query('mode') === 'private' ? 'private' : 'public';

  const key = cacheKey(imageUrl, width, height, quality);

  const cached = mode === 'public' ? cache.get(key) : undefined;
  if (cached !== undefined && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    cached.lastUsed = Date.now();
    return imageResponse(cached.data, cached.mimeType, mode);
  }

  try {
    // Deliberately bare `fetch`, NOT `getUpstreamCircuit('...').fetch`.
    // Our breakers are keyed per fixed endpoint category
    // (`login`, `gift-cards`, etc.). Image URLs here are arbitrary
    // allowlisted hosts — one bad host would trip a shared breaker and
    // fail every other host's logo fetches. This handler already has a
    // `FETCH_TIMEOUT_MS` bound + a 100 MB / 7-day LRU cache in front,
    // which is the right level of protection for this shape. Documented
    // exception in `apps/backend/AGENTS.md` under "Upstream calls
    // always use". See also ADR-005 §5 (DNS rebinding rationale).
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

    // Inspect the input to decide output format: inputs with an alpha
    // channel (typically PNG merchant logos on transparent backgrounds)
    // must not be re-encoded as JPEG — that would paint the transparent
    // pixels a flat colour. WebP preserves alpha, is smaller than PNG, and
    // is supported by every browser we target (Safari 14+, Chrome/Firefox
    // current, WebKit on Capacitor).
    const metadata = await sharp(buffer).metadata();
    const hasAlpha = metadata.hasAlpha === true;

    let pipeline = sharp(buffer);

    if (width > 0 || height > 0) {
      pipeline = pipeline.resize(width || null, height || null, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    const encoded = hasAlpha
      ? await pipeline.webp({ quality }).toBuffer({ resolveWithObject: true })
      : await pipeline.jpeg({ quality }).toBuffer({ resolveWithObject: true });
    const { data, info } = encoded;
    const mimeType = hasAlpha ? 'image/webp' : 'image/jpeg';
    const output = new Uint8Array(data);

    if (mode === 'public' && output.byteLength <= MAX_CACHE_BYTES) {
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
    return imageResponse(output, mimeType, mode);
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

function imageResponse(data: Uint8Array, mimeType: string, mode: 'public' | 'private'): Response {
  return new Response(data, {
    headers: {
      'Content-Type': mimeType,
      'Cache-Control':
        mode === 'private' ? 'private, no-store' : 'public, max-age=604800, immutable',
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

// SSRF guard (URL-validate + IP-range checks) lives in
// `./ssrf-guard.ts`. Imported back here for the single call site
// in `imageProxyHandler`.
import { validateImageUrl } from './ssrf-guard.js';

function clampDimension(v: number): number {
  if (isNaN(v) || v <= 0) return 0;
  return Math.min(v, MAX_DIMENSION);
}

function clampQuality(v: number): number {
  if (isNaN(v)) return 80;
  return Math.max(1, Math.min(v, 100));
}
