// `POST /api/public/rum` — ADR 048, ADR 020
import type { Context } from 'hono';
import { z } from 'zod';
import { WEB_VITAL_NAMES } from '@loop/shared';
import { recordWebVital, incrementPageView } from '../metrics.js';

const RumBody = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('vital'),
      name: z.enum(WEB_VITAL_NAMES),
      // Bounded to defend histogram `sum` against malicious/broken clients
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
    // Never-500 (ADR 020): analytics intake must not 5xx a real user's page load
    return c.json({ ok: true }, 200);
  }
}
