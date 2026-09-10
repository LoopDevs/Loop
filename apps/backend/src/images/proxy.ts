import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import type { Context } from 'hono';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { getMerchants } from '../merchants/sync.js';
import { getMapPinUrl } from '../clustering/data-store.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DIMENSION = 2000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE_BYTES = 100 * 1024 * 1024;
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

function cacheKey(
  url: string,
  width: number,
  height: number,
  quality: number,
  version: string,
): string {
  return `${url}|${width}|${height}|${quality}|${version}`;
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

const IMAGE_KINDS = ['logo', 'card', 'pin'] as const;
type ImageKind = (typeof IMAGE_KINDS)[number];

function isImageKind(v: string): v is ImageKind {
  return (IMAGE_KINDS as readonly string[]).includes(v);
}

// Mirrors the sync layer's MAX_ID_LENGTH bound on upstream merchant ids.
const MERCHANT_ID_RE = /^[\w.-]{1,128}$/;

// ADR 050
export async function imageProxyHandler(c: Context): Promise<Response> {
  const log = logger.child({ handler: 'image-proxy' });

  const merchantId = c.req.query('merchantId') ?? '';
  const kind = c.req.query('kind') ?? '';
  if (!MERCHANT_ID_RE.test(merchantId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is required' }, 400);
  }
  if (!isImageKind(kind)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'kind must be logo, card, or pin' }, 400);
  }

  const merchant = getMerchants().merchantsById.get(merchantId);
  if (merchant === undefined) {
    return c.json({ code: 'NOT_FOUND', message: 'Merchant not found' }, 404);
  }

  const imageUrl =
    kind === 'logo'
      ? merchant.logoUrl
      : kind === 'card'
        ? merchant.cardImageUrl
        : (getMapPinUrl(merchantId) ?? merchant.logoUrl);
  if (imageUrl === undefined || imageUrl === null) {
    return c.json({ code: 'NOT_FOUND', message: `Merchant has no ${kind} image` }, 404);
  }

  const urlError = await validateResolvedImageUrl(imageUrl);
  if (urlError !== null) {
    // The URL is CTX catalog data, not client input — a rejection means
    // the upstream record is unusable, which is an upstream problem.
    log.warn({ merchantId, kind, reason: urlError }, 'Resolved merchant image URL rejected');
    return c.json({ code: 'UPSTREAM_ERROR', message: 'Upstream image URL is not usable' }, 502);
  }

  const width = clampDimension(parseInt(c.req.query('width') ?? '0', 10));
  const height = clampDimension(parseInt(c.req.query('height') ?? '0', 10));
  const quality = clampQuality(parseInt(c.req.query('quality') ?? '80', 10));
  // Bounded so unbounded distinct cache keys can't be minted for one
  // image by rotating an arbitrarily long `v` — beyond the length cap
  // the LRU itself bounds total memory, same as rotating `quality`.
  const version = (c.req.query('v') ?? '').slice(0, 64);

  const key = cacheKey(imageUrl, width, height, quality, version);

  const cached = cache.get(key);
  if (cached !== undefined && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    cached.lastUsed = Date.now();
    return imageResponse(cached.data, cached.mimeType, 'public');
  }

  const result = await fetchAndTransformImage(imageUrl, { width, height, quality });
  if (!result.ok) {
    return c.json({ code: result.code, message: result.message }, result.status);
  }
  const { data, mimeType } = result;

  if (data.byteLength <= MAX_CACHE_BYTES) {
    // Overwrite accounting: a TTL-expired entry for the same key is
    // replaced (not added), so its bytes must come off the counter
    // first — otherwise `totalCacheBytes` drifts upward on every
    // refresh and the LRU evicts earlier and earlier until the
    // cache is effectively disabled (comprehensive-audit
    // 2026-06-11, P10).
    const previous = cache.get(key);
    if (previous !== undefined) {
      cache.delete(key);
      totalCacheBytes -= previous.sizeBytes;
    }
    evictLruUntilFits(data.byteLength);
    cache.set(key, {
      data,
      mimeType,
      cachedAt: Date.now(),
      lastUsed: Date.now(),
      sizeBytes: data.byteLength,
    });
    totalCacheBytes += data.byteLength;
  }

  return imageResponse(data, mimeType, 'public');
}

export type ImageFetchResult =
  | { ok: true; data: Uint8Array; mimeType: string }
  | { ok: false; status: 413 | 500 | 502; code: string; message: string };

export async function fetchAndTransformImage(
  imageUrl: string,
  opts: { width: number; height: number; quality: number; forceJpeg?: boolean },
): Promise<ImageFetchResult> {
  const log = logger.child({ handler: 'image-proxy' });
  const { width, height, quality } = opts;
  try {
    // The FETCH_TIMEOUT_MS bound is the protection here: image hosts
    // vary per record, so there is no fixed upstream to reason about
    // beyond capping how long any one host can stall us.
    const upstream = await __imageUpstream.fetch(imageUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'manual',
    });

    // Reject redirects — following them would hand URL control to the
    // image host's owner, sidestepping the resolved-URL validation.
    if (upstream.status >= 300 && upstream.status < 400) {
      return {
        ok: false,
        status: 502,
        code: 'UPSTREAM_REDIRECT',
        message: 'Redirects from upstream are not allowed',
      };
    }

    if (!upstream.ok) {
      return {
        ok: false,
        status: 502,
        code: 'UPSTREAM_ERROR',
        message: `Upstream returned ${upstream.status}`,
      };
    }

    const contentType = (upstream.headers.get('Content-Type') ?? '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      return {
        ok: false,
        status: 502,
        code: 'NOT_AN_IMAGE',
        message: 'Upstream response is not an image',
      };
    }

    const declaredLength = parseInt(upstream.headers.get('Content-Length') ?? '0', 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        status: 413,
        code: 'IMAGE_TOO_LARGE',
        message: 'Image exceeds 10 MB limit',
      };
    }

    const buffer = await readBodyWithLimit(upstream, MAX_IMAGE_BYTES);
    if (buffer === null) {
      return {
        ok: false,
        status: 413,
        code: 'IMAGE_TOO_LARGE',
        message: 'Image exceeds 10 MB limit',
      };
    }

    // Inspect the input to decide output format: inputs with an alpha
    // channel (typically PNG merchant logos on transparent backgrounds)
    // must not be re-encoded as JPEG — that would paint the transparent
    // pixels a flat colour. WebP preserves alpha, is smaller than PNG, and
    // is supported by every browser we target (Safari 14+, Chrome/Firefox
    // current, WebKit on Capacitor).
    const metadata = await sharp(buffer).metadata();
    const hasAlpha = metadata.hasAlpha === true && opts.forceJpeg !== true;

    let pipeline = sharp(buffer);
    if (opts.forceJpeg === true) {
      pipeline = pipeline.flatten({ background: '#ffffff' });
    }

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

    log.debug(
      { url: imageUrl, width: info.width, height: info.height, bytes: output.byteLength },
      'Image processed',
    );
    return { ok: true, data: output, mimeType };
  } catch (err) {
    log.error({ err, url: imageUrl }, 'Image proxy error');
    return { ok: false, status: 500, code: 'INTERNAL_ERROR', message: 'Failed to process image' };
  }
}

// Test seam: byte-counter + entry-count snapshot so the LRU
// accounting (incl. the overwrite path above) can be asserted
// without exporting the cache map itself.
export function __getImageCacheStatsForTests(): { entries: number; totalBytes: number } {
  return { entries: cache.size, totalBytes: totalCacheBytes };
}

/** Test seam: clears the cache and resets the byte counter. */
export function __resetImageCacheForTests(): void {
  cache.clear();
  totalCacheBytes = 0;
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

export function imageResponse(
  data: Uint8Array,
  mimeType: string,
  mode: 'public' | 'private',
): Response {
  return new Response(data, {
    headers: {
      'Content-Type': mimeType,
      'Cache-Control':
        mode === 'private' ? 'private, no-store' : 'public, max-age=604800, immutable',
    },
  });
}

// Streaming read ensures we do not buffer a multi-GB response into memory just to reject it.
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

// Resolved-URL validation (production https + public-IP requirement;
// permissive outside production) lives in `./ssrf-guard.ts`, together
// with `ssrfSafeLookup`, the connect-time resolver that closes the
// DNS-rebinding gap on the actual fetch below.
import { validateResolvedImageUrl, ssrfSafeLookup } from './ssrf-guard.js';

interface UpstreamFetchInit {
  signal?: AbortSignal;
  redirect?: 'manual';
}

// Fetch-spec null-body statuses: the global `Response` ctor throws if
// handed a body for these. The handler rejects all of them anyway (3xx →
// UPSTREAM_REDIRECT; 204/205/304 → NOT_AN_IMAGE), so we drain the socket
// and hand back a bodiless Response.
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

// Upstream fetch on node core. In production the connecting socket
// resolves DNS through `ssrfSafeLookup`, which range-checks the address
// the request will actually connect to — closing the DNS-rebinding
// TOCTOU where a resolver answers public to `validateResolvedImageUrl`
// and private to the fetch. Outside production the default resolver is
// used so local CTX file hosts work. `agent: false` forces a fresh
// lookup per request (no keep-alive socket reuse). Node core never
// auto-follows redirects, so a 3xx surfaces as a status the handler
// rejects.
function upstreamImageFetch(rawUrl: string, init: UpstreamFetchInit): Promise<Response> {
  const transport = new URL(rawUrl).protocol === 'http:' ? http : https;
  return new Promise<Response>((resolve, reject) => {
    const req = transport.request(
      rawUrl,
      {
        method: 'GET',
        ...(config.env === 'production' ? { lookup: ssrfSafeLookup } : {}),
        agent: false,
        signal: init.signal,
      },
      (res) => {
        const status = res.statusCode ?? 502;
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') headers.set(name, value);
          else if (Array.isArray(value)) headers.set(name, value.join(', '));
        }
        if (NULL_BODY_STATUSES.has(status)) {
          res.resume(); // drain so the socket can close
          resolve(new Response(null, { status, headers }));
          return;
        }
        const body = Readable.toWeb(res) as ReadableStream<Uint8Array>;
        resolve(new Response(body, { status, headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// Test seam: the proxy tests replace `fetch` here with a stub returning
// a synthetic `Response` so they exercise the resize/cache/redirect
// handling without real sockets. The connect-time rebind defence itself
// is proven directly in `ssrf-guard.test.ts`.
export const __imageUpstream: {
  fetch: (url: string, init: UpstreamFetchInit) => Promise<Response>;
} = { fetch: upstreamImageFetch };

export function clampDimension(v: number): number {
  if (isNaN(v) || v <= 0) return 0;
  return Math.min(v, MAX_DIMENSION);
}

export function clampQuality(v: number): number {
  if (isNaN(v)) return 80;
  return Math.max(1, Math.min(v, 100));
}
