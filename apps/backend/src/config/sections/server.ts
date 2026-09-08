/**
 * config section: `server:` — the HTTP listener and its trust boundary.
 *
 * A section module is a zod schema for one top-level key of
 * `config.yaml`, spread into the composed `ConfigSchema` in
 * `../schema.ts`. Add new keys for this group HERE — it keeps
 * `schema.ts` from being a merge-conflict magnet, and keeps the
 * schema's shape a 1:1 mirror of the YAML file's shape.
 */
import { z } from 'zod';

export const serverSchema = z
  .object({
    // The port the Hono server binds. Fly's `internal_port` in
    // `apps/backend/fly.toml` must match this.
    port: z.number().int().min(1).max(65535).default(8080),

    // 'silent' and 'fatal' are valid pino levels; include them so tests
    // and emergency ops configs don't require bypassing validation.
    logLevel: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),

    // Rate-limiter trust boundary (audit A-023). When `true` the rate
    // limiter reads the client IP from the first value in
    // X-Forwarded-For (required when running behind Fly.io / a load
    // balancer). When `false` it falls back to the TCP socket's remote
    // address so an arbitrary client cannot spoof its own IP to bypass
    // per-IP limits. Default `false` — a deployment behind a trusted
    // edge sets it to `true` explicitly.
    trustProxy: z.boolean().default(false),
  })
  .prefault({});
