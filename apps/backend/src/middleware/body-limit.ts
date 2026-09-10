// 1 MiB request-body cap — A2-1005
import { bodyLimit } from 'hono/body-limit';

const ONE_MIB = 1024 * 1024;

export const bodyLimitMiddleware = bodyLimit({
  maxSize: ONE_MIB,
  onError: (c) =>
    c.json({ code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 1 MB limit' }, 413),
});
