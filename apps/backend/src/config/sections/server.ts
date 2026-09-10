// config section: `server:` — HTTP listener and trust boundary
import { z } from 'zod';

export const serverSchema = z
  .object({
    // Must match `internal_port` in `apps/backend/fly.toml`
    port: z.number().int().min(1).max(65535).default(8080),

    // Includes 'silent' and 'fatal' for test/emergency ops configs
    logLevel: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),

    // Rate-limiter trust boundary (audit A-023). When `true`, reads client IP from X-Forwarded-For (required behind Fly.io/LB).
    // When `false`, uses TCP socket remote address to prevent IP spoofing for per-IP limit bypass.
    trustProxy: z.boolean().default(false),
  })
  .prefault({});
