import type { ImageProxyParams } from '@loop/shared';
import { API_BASE } from '~/services/config';

/**
 * Returns a Loop image-proxy URL for the given upstream image URL.
 * If width is 0 or undefined, no resize is applied. Shape of the
 * emitted query params matches `ImageProxyParams` in @loop/shared,
 * which mirrors the backend's `GET /api/image` zod validator.
 */
export function getImageProxyUrl(
  url: string,
  width = 0,
  quality = 80,
  options: { mode?: ImageProxyParams['mode']; version?: string | undefined } = {},
): string {
  const query: ImageProxyParams = { url, quality };
  if (width > 0) query.width = width;
  if (options.mode !== undefined) query.mode = options.mode;
  // Cache-busting version (typically `merchant.updatedAt`): folded into
  // the backend proxy's LRU key and, by changing the URL, busts the
  // browser's 7-day immutable cache — so a same-URL image edit on CTX
  // shows up as soon as the catalog carries the new timestamp.
  if (options.version !== undefined && options.version !== '') query.v = options.version;
  const params = new URLSearchParams({
    url: query.url,
    quality: String(query.quality),
    ...(query.width !== undefined ? { width: String(query.width) } : {}),
    ...(query.mode !== undefined ? { mode: query.mode } : {}),
    ...(query.v !== undefined ? { v: query.v } : {}),
  });
  return `${API_BASE}/api/image?${params.toString()}`;
}
