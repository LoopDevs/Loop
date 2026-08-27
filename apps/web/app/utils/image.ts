import type { ImageProxyParams } from '@loop/shared';
import { API_BASE } from '~/services/config';

/**
 * Builds a Loop image-proxy URL for a merchant image (ADR 050 —
 * reference-keyed: the client names the image by merchant id + kind and
 * the backend resolves the actual upstream URL from its own catalog,
 * so no URL ever travels from the client). Shape of the emitted query
 * params matches `ImageProxyParams` in @loop/shared, which mirrors the
 * backend's `GET /api/image` validator.
 *
 * `merchant.updatedAt` rides along as the `v` cache-busting version:
 * it changes on every CTX merchant edit, so an image swap busts both
 * the proxy's LRU key and the browser's 7-day immutable cache. If
 * width is 0 or undefined, no resize is applied.
 */
export function getMerchantImageUrl(
  merchant: { id: string; updatedAt?: string | undefined },
  kind: ImageProxyParams['kind'],
  width = 0,
  quality = 80,
): string {
  const params = new URLSearchParams({
    merchantId: merchant.id,
    kind,
    quality: String(quality),
    ...(width > 0 ? { width: String(width) } : {}),
    ...(merchant.updatedAt !== undefined && merchant.updatedAt !== ''
      ? { v: merchant.updatedAt }
      : {}),
  });
  return `${API_BASE}/api/image?${params.toString()}`;
}
