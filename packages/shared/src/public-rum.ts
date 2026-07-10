/**
 * Public RUM (real-user-monitoring) wire shape (ADR 048 / 020).
 *
 * Single source of truth for the `POST /api/public/rum` request body
 * consumed by both `apps/backend/src/public/rum.ts` (Zod validation +
 * `/metrics` recording) and `apps/web/app/services/analytics.ts` (the
 * client that sends it). Cookieless, no PII, no persistent identifier
 * — see ADR 048 for the full privacy posture.
 */

/** Fixed Core Web Vitals set captured by the `web-vitals` client library. */
export const WEB_VITAL_NAMES = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const;

/** One of the five Core Web Vitals. */
export type WebVitalName = (typeof WEB_VITAL_NAMES)[number];

/** A single Core Web Vital observation. */
export interface RumVitalEvent {
  type: 'vital';
  name: WebVitalName;
  /** Raw value in the vital's native unit — ms for LCP/INP/FCP/TTFB, an unitless layout-shift score for CLS. */
  value: number;
}

/** A bare page-view marker — one per app load, no route breakdown (see ADR 048). */
export interface RumPageViewEvent {
  type: 'pageview';
}

/** `POST /api/public/rum` request body. */
export type RumEvent = RumVitalEvent | RumPageViewEvent;
