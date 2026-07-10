/**
 * `POST /api/public/rum` (ADR 048) — first-party, cookieless
 * real-user-monitoring intake. Accepts one Core Web Vital observation
 * or a bare page-view marker and folds it straight into the
 * `/metrics` Prometheus surface (`loop_web_vital_*` histograms,
 * `loop_page_views_total` counter). No DB table, no persisted event
 * row, no per-user/per-session identifier read or stored — see
 * ADR 048 for the full privacy posture.
 *
 * ADR 020 public-surface discipline: unauthenticated, never-500 (a
 * malformed body is a 400, not a crash; anything else unexpected is
 * swallowed rather than thrown), no-PII, bounded body (a five-value
 * discriminated union — there's no dimension along which a valid body
 * grows), `Cache-Control: no-store` since this is a write with
 * nothing cacheable in the response.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { WEB_VITAL_NAMES } from '@loop/shared';
import { recordWebVital, incrementPageView } from '../metrics.js';

const RumBody = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('vital'),
      name: z.enum(WEB_VITAL_NAMES),
      // Generous but bounded — defends the histogram `sum` against a
      // malicious/broken client sending an absurd value. Real Web
      // Vitals values never approach this (LCP/INP/FCP/TTFB are ms,
      // typically under 30s even on a terrible connection; CLS is a
      // small unitless score).
      value: z.number().finite().min(0).max(600_000),
    })
    .strict(),
  z.object({ type: z.literal('pageview') }).strict(),
]);

export async function publicRumHandler(c: Context): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  try {
    const parsed = RumBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid RUM event' }, 400);
    }
    if (parsed.data.type === 'vital') {
      recordWebVital(parsed.data.name, parsed.data.value);
    } else {
      incrementPageView();
    }
    return c.json({ ok: true }, 200);
  } catch {
    // Never-500 (ADR 020): analytics intake must not be able to 5xx a
    // real user's page load. Anything unexpected beyond the validated
    // paths above is dropped silently rather than propagated.
    return c.json({ ok: true }, 200);
  }
}
