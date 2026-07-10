#!/usr/bin/env node
/**
 * Test-only backend entry wrapper for the loop-native
 * purchase-through-the-UI e2e suite (Q6-4, docs/money-auth-worklist.md).
 *
 * `@stellar/stellar-sdk`'s `Horizon.Server` refuses to connect to a
 * plain-`http://` URL by default (`Cannot connect to insecure horizon
 * server` — see `node_modules/@stellar/stellar-sdk/lib/horizon/server.js`)
 * unless `Config.setAllowHttp(true)` has been called somewhere in the
 * process first. `apps/backend/src/payments/payout-submit.ts`
 * (correctly, for production) never does this — real Horizon is always
 * `https://`. `tests/e2e-loop-purchase/fixtures/mock-horizon.mjs` is a
 * plain in-memory HTTP server (no TLS) so the procurement worker's
 * `payCtxOrder` hop can build/sign/submit against it.
 *
 * Rather than weaken that production safety check inside
 * `apps/backend/src/**`, this wrapper flips the SDK's process-global
 * flag from OUTSIDE the app's own source, before importing it — the
 * `Config` class is a singleton (module-level state shared by every
 * importer in the same process), so setting it here before
 * `../../../apps/backend/src/index.ts` boots is sufficient. Only ever
 * invoked as this suite's own webServer `command` (see
 * `playwright.loop-purchase.config.ts`) — never referenced by the real
 * `apps/backend` start scripts, package.json, Dockerfile, or fly.toml.
 */
import { Config } from '@stellar/stellar-sdk';

Config.setAllowHttp(true);

await import('../../../apps/backend/src/index.ts');
