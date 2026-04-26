/**
 * 1 MiB request-body cap. Pulled out of `app.ts` (audit A2-1005)
 * so the cap value + the `{ code, message }` error envelope have a
 * single home.
 *
 * The default `bodyLimit` error handler lets the middleware throw,
 * which Hono's fallback handler turns into a 500. The correct HTTP
 * status for "request body exceeds declared limit" is 413 Payload
 * Too Large, and the error envelope should match the
 * `{ code, message }` shape every other handler uses — so we
 * provide an explicit `onError` that emits the right payload.
 */
import { bodyLimit } from 'hono/body-limit';

const ONE_MIB = 1024 * 1024;

export const bodyLimitMiddleware = bodyLimit({
  maxSize: ONE_MIB,
  onError: (c) =>
    c.json({ code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 1 MB limit' }, 413),
});
