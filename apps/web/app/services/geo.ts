import type { GeoResponse } from '@loop/shared';

import { apiRequest } from './api-client';

/**
 * Best-guess region from the caller's IP — backend `/api/public/geo` (ADR 033).
 * Never-500 on the server; falls back to `{ countryCode: '', region: 'US' }`.
 */
export async function fetchGeo(): Promise<GeoResponse> {
  return apiRequest<GeoResponse>('/api/public/geo');
}
