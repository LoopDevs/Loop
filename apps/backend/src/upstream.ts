import { env } from './env.js';

/** Builds a full URL to the upstream CTX API. */
export function upstreamUrl(path: string): string {
  return `${env.GIFT_CARD_API_BASE_URL.replace(/\/$/, '')}${path}`;
}
