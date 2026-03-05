import { API_BASE } from '~/services/config';

/**
 * Returns a Loop image-proxy URL for the given upstream image URL.
 * If width is 0 or undefined, no resize is applied.
 */
export function getImageProxyUrl(url: string, width = 0, quality = 80): string {
  const params = new URLSearchParams({ url });
  if (width > 0) params.set('width', String(width));
  params.set('quality', String(quality));
  return `${API_BASE}/api/image?${params.toString()}`;
}
