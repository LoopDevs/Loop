// config.yaml schema — composed over ./sections/
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

// Exported for tests; production code should consume the validated `config` object from `./index.ts`
export const ConfigSchema = z.object({
  // Overridden by `NODE_ENV` when set in the process environment
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
