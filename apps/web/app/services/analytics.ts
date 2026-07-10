import type { RumEvent } from '@loop/shared';
import { apiRequest } from './api-client';

// Wire shape lives in `@loop/shared` — one source of truth with the
// backend's Zod schema (ADR 019 / 048). Re-exported so callers can
// import from this service without also reaching into `@loop/shared`
// directly.
export type { RumEvent, RumVitalEvent, RumPageViewEvent, WebVitalName } from '@loop/shared';

/**
 * `POST /api/public/rum` (ADR 048) — best-effort, fire-and-forget.
 * Never throws: analytics must not be able to break the app or
 * surface an error to the user. Cookieless, no persistent id — the
 * event body carries only a Core Web Vital name+value or a bare
 * page-view marker.
 *
 * Callers should not `await` this for UX purposes (nothing depends on
 * it succeeding); it's async only so a caller that *does* want to
 * know completion — tests, mainly — can.
 */
export async function sendRumEvent(event: RumEvent): Promise<void> {
  try {
    await apiRequest('/api/public/rum', { method: 'POST', body: event, timeoutMs: 5000 });
  } catch {
    // Best-effort telemetry: network errors, rate limits, and a
    // disabled/unreachable backend must never surface to the caller.
  }
}
