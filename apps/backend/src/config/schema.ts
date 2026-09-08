/**
 * The `config.yaml` schema — the composed `ConfigSchema` over the
 * section modules in `./sections/`.
 *
 * This is the file-and-schema mirror of the old flat `env.ts`: the
 * section modules under `./sections/` mirror the YAML file's shape
 * one-for-one, so the file and the schema can be read side by side.
 * Several former boot guards are gone entirely — see the section
 * modules for which, and why.
 *
 * Loaded, parsed and validated by `./index.ts`, which also runs the
 * cross-field guards that a per-section schema can't express.
 */
import { z } from 'zod';
import { serverSchema } from './sections/server.js';
import { ctxSchema, catalogSchema } from './sections/ctx.js';
import { databaseSchema } from './sections/database.js';
import { authSchema, emailSchema } from './sections/auth.js';
import { adminSchema } from './sections/admin.js';
import { ordersSchema } from './sections/orders.js';
import {
  rateLimitSchema,
  launchSchema,
  testingSchema,
  unsafeSchema,
} from './sections/operations.js';
import { observabilitySchema, mobileSchema } from './sections/observability.js';

/**
 * The whole of `config.yaml`. Exported so tests can exercise it
 * directly; production code should consume the validated `config`
 * object exported from `./index.ts`, not the raw schema.
 */
export const ConfigSchema = z.object({
  // Deployment environment. Overridden by `NODE_ENV` when that is set
  // in the process environment — see the module comment in `./index.ts`.
  env: z.enum(['development', 'production', 'test']).default('development'),
  server: serverSchema,
  ctx: ctxSchema,
  catalog: catalogSchema,
  database: databaseSchema,
  auth: authSchema,
  admin: adminSchema,
  email: emailSchema,
  orders: ordersSchema,
  rateLimit: rateLimitSchema,
  observability: observabilitySchema,
  mobile: mobileSchema,
  launch: launchSchema,
  testing: testingSchema,
  unsafe: unsafeSchema,
});

export type Config = z.infer<typeof ConfigSchema>;
