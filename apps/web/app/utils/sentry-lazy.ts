/**
 * Lazy Sentry loader (PERF-004 — audit 2026-06-15-cold / CF-29).
 *
 * `@sentry/react` is ~540 KB — the single largest module in the web
 * bundle. Statically importing it into `root.tsx` pulled the whole SDK
 * into the always-loaded root chunk, so every visitor downloaded and
 * parsed it on first paint even on DSN-unset deploys where Sentry never
 * runs. This module keeps the SDK out of the critical-path root chunk by
 * loading it via dynamic `import('@sentry/react')`, code-split into its
 * own chunk fetched after first paint / on idle.
 *
 * Init behaviour is unchanged: gated on `VITE_SENTRY_DSN`, same
 * `browserTracingIntegration` (CLS/LCP/LongAnimationFrame spans),
 * `tracesSampleRate`, release/environment tags, and `beforeSend`
 * scrubber. `captureException` callers (QueryCache/MutationCache
 * `onError`, the route `ErrorBoundary`) keep working before the SDK has
 * finished loading: the call triggers the lazy load and resolves the
 * event id once the SDK is ready, or no-ops if Sentry is disabled.
 */
import type * as SentryType from '@sentry/react';
import { scrubSentryEvent } from '~/utils/sentry-scrubber';

type SentryModule = typeof SentryType;

let sentryPromise: Promise<SentryModule> | null = null;

/** Resolved once `runInit` has actually called `Sentry.init`. */
let initialized = false;

/** True when a DSN is configured and we should load + init the SDK. */
function sentryEnabled(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof import.meta.env.VITE_SENTRY_DSN === 'string' &&
    import.meta.env.VITE_SENTRY_DSN !== ''
  );
}

/** Dynamically import `@sentry/react`, memoising the module promise. */
function loadSentry(): Promise<SentryModule> {
  sentryPromise ??= import('@sentry/react');
  return sentryPromise;
}

function runInit(Sentry: SentryModule): void {
  if (initialized) return;
  initialized = true;
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    // A2-1310: prefer the explicit `VITE_LOOP_ENV` deploy tag so a
    // staging build bucketed as `MODE=production` can still report
    // events as `staging`. Falls back to `MODE` so existing deploys
    // without the env var set continue to behave as before.
    environment: (import.meta.env.VITE_LOOP_ENV as string | undefined) ?? import.meta.env.MODE,
    // A2-1309: release tag pivots a Sentry event back to the deploy
    // artifact. CI/CD sets `VITE_SENTRY_RELEASE` to the git SHA at
    // build time; left unset on dev so Sentry omits the attribute.
    ...(import.meta.env.VITE_SENTRY_RELEASE !== undefined &&
    import.meta.env.VITE_SENTRY_RELEASE !== ''
      ? { release: import.meta.env.VITE_SENTRY_RELEASE as string }
      : {}),
    // A2-1324: enable standalone CLS + LCP spans so Core Web Vitals
    // land in Sentry as their own metrics (not just attached to a
    // sampled trace). At 10% trace sampling, ~90% of pageloads
    // wouldn't ship LCP/CLS otherwise; standalone spans bypass the
    // trace-sample gate so RUM data covers the full traffic. INP and
    // long-task spans are on by default and stay that way.
    // `enableLongAnimationFrame` flips on so jank attribution surfaces
    // in the trace timeline (rendering blocked > 50ms).
    integrations: [
      Sentry.browserTracingIntegration({
        enableLongAnimationFrame: true,
        _experiments: {
          enableStandaloneClsSpans: true,
          enableStandaloneLcpSpans: true,
        },
      }),
    ],
    tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
    // A2-1308: scrub known-secret keys out of every captured event.
    // Mirror of the backend Sentry init; utility is duplicated across
    // apps/web and apps/backend (they don't share a build).
    beforeSend: (event) => scrubSentryEvent(event),
  });
}

/**
 * Kick off the Sentry load + init off the critical path. No-op on the
 * server and when no DSN is set. Schedules on `requestIdleCallback`
 * (falling back to a short timeout) so the SDK chunk fetch + parse
 * doesn't compete with first paint. Safe to call repeatedly — the load
 * promise and `init` are both memoised.
 */
export function initSentryLazily(): void {
  if (!sentryEnabled()) return;
  const schedule = (cb: () => void): void => {
    const ric = (
      window as typeof window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    if (typeof ric === 'function') {
      ric(cb, { timeout: 2000 });
    } else {
      window.setTimeout(cb, 1);
    }
  };
  schedule(() => {
    void loadSentry().then(runInit);
  });
}

/**
 * Capture an already-scrubbed error. Returns the Sentry event id once
 * the SDK has loaded + initialised, or `undefined` when Sentry is
 * disabled (no DSN) or unavailable. Loads the SDK on demand so an error
 * thrown before the idle-time init still gets reported.
 *
 * Callers pre-scrub via `scrubErrorForSentry` exactly as before — this
 * helper does not re-scrub the thrown value (it owns only the event
 * pipeline `beforeSend` scrub configured in `runInit`).
 */
export async function captureExceptionLazily(
  error: unknown,
  hint?: Parameters<SentryModule['captureException']>[1],
): Promise<string | undefined> {
  if (!sentryEnabled()) return undefined;
  try {
    const Sentry = await loadSentry();
    runInit(Sentry);
    return hint !== undefined
      ? Sentry.captureException(error, hint)
      : Sentry.captureException(error);
  } catch {
    // Loading/initialising Sentry must never break the app — swallow.
    return undefined;
  }
}
