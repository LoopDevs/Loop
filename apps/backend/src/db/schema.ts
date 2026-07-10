/**
 * Drizzle schema barrel (hardening D2 split). The schema was one
 * 1,515-line file — the repo's #1 merge-conflict magnet, since every
 * feature adds a table or column here. It's now split into per-domain
 * modules under `./schema/`; this barrel re-exports them so every
 * existing `import { ... } from '../db/schema.js'` call site, the
 * `import * as schema` in `db/client.ts`, and drizzle-kit's
 * `schema: './src/db/schema.ts'` config all resolve unchanged.
 *
 * Add a new table to the domain module it belongs to (or a new module
 * + a line here), NOT to one giant file.
 */
export * from './schema/users.js';
export * from './schema/credits.js';
export * from './schema/merchants.js';
export * from './schema/auth.js';
export * from './schema/orders.js';
export * from './schema/payments.js';
export * from './schema/admin.js';
export * from './schema/reconciliation.js';
export * from './schema/fraud.js';
export * from './schema/vaults.js';
