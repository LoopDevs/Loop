/**
 * Sentry SDK initialization for the backend (ADR-... / A2-1308 / A2-1309 / A2-1310).
 *
 * `@sentry/hono` 10.51 split init from middleware: `init()` must run
 * BEFORE any user code so OpenTelemetry's auto-instrumentation can
 * patch the http/https modules at first import. This file is loaded
 * via Node's `--import` flag (see backend `package.json` scripts +
 * `Dockerfile` CMD) so the side-effect runs before `src/index.ts`.
 *
 * Pre-10.51 the equivalent config lived inline in `app.ts` next to
 * `app.use(sentry(app, {...}))`. The middleware config has been
 * preserved verbatim here; the only change is the location.
 */
import { init } from '@sentry/hono/node';
import { env } from './env.js';
import { scrubSentryEvent } from './sentry-scrubber.js';

if (env.SENTRY_DSN) {
  init({
    dsn: env.SENTRY_DSN,
    // A2-1310: `LOOP_ENV` is the explicit logical-env tag so a
    // staging deploy that sets `NODE_ENV=production` can still
    // bucket events as `staging`. Falls back to NODE_ENV so
    // existing prod + dev deploys are unaffected.
    environment: env.LOOP_ENV ?? env.NODE_ENV,
    // A2-1309: release tag pivots a Sentry event back to the
    // deploy artifact. CI/CD sets `SENTRY_RELEASE` to the git SHA.
    // Absent → Sentry omits the attribute (pre-launch default; dev
    // runs don't poison the release pivot).
    ...(env.SENTRY_RELEASE !== undefined ? { release: env.SENTRY_RELEASE } : {}),
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 1.0,
    // A2-1308: scrub known-secret keys out of every captured event
    // before it leaves the process. Sentry's sendDefaultPii:false
    // default handles the well-known PII fields; this catches the
    // Loop-specific secrets (env-named signing keys, CTX API
    // credentials, DATABASE_URL, Discord webhooks) that would
    // otherwise land in `extra` / `contexts` / `request.headers`.
    beforeSend: (event) => scrubSentryEvent(event),
  });
}
