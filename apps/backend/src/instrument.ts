// Sentry SDK init — A2-1308, A2-1309, A2-1310
import { init } from '@sentry/hono/node';
import { config } from './config/index.js';
import { scrubSentryEvent } from './sentry-scrubber.js';

if (config.observability.sentry.dsn) {
  init({
    dsn: config.observability.sentry.dsn,
    // A2-1310: explicit logical-env tag so staging with NODE_ENV=production buckets as staging
    environment: config.observability.environmentTag ?? config.env,
    // A2-1309: release tag pivots events to deploy artifact; CI/CD sets SENTRY_RELEASE to git SHA
    ...(config.observability.sentry.release !== undefined
      ? { release: config.observability.sentry.release }
      : {}),
    tracesSampleRate: config.env === 'production' ? 0.1 : 1.0,
    // A2-1308: scrub Loop-specific secrets (signing keys, CTX creds, DATABASE_URL, Discord webhooks)
    beforeSend: (event) =>
      scrubSentryEvent(
        event as unknown as Parameters<typeof scrubSentryEvent>[0],
      ) as unknown as typeof event,
  });
}
