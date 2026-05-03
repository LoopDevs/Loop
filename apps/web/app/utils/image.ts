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
  options: { mode?: ImageProxyParams['mode'] } = {},
): string {
  const query: ImageProxyParams = { url, quality };
  if (width > 0) query.width = width;
  if (options.mode !== undefined) query.mode = options.mode;
  const params = new URLSearchParams({
    url: query.url,
    quality: String(query.quality),
    ...(query.width !== undefined ? { width: String(query.width) } : {}),
    ...(query.mode !== undefined ? { mode: query.mode } : {}),
  });
  return `${API_BASE}/api/image?${params.toString()}`;
}
