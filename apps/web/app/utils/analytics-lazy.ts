/**
 * Lazy, env-gated Core Web Vitals + page-view capture (ADR 048).
 *
 * Mirrors `sentry-lazy.ts`'s shape: gated on an env var, the actual
 * `web-vitals` module is dynamically imported off the critical path
 * (idle-scheduled, same as the Sentry loader) so a deploy that leaves
 * `VITE_ANALYTICS_ENABLED` unset — the default — pays zero bundle or
 * runtime cost. Dark by default: this ships the capability, not an
 * operator decision to turn it on (see ADR 048's follow-up note).
 *
 * The actual network call goes through `~/services/analytics`
 * (`sendRumEvent`), never a raw `fetch()` here — this module only
 * wires the `web-vitals` callbacks to that service call.
 */
import { sendRumEvent } from '~/services/analytics';

let initialized = false;

/** True when the analytics capture flag is on. Client-only — always false during SSR. */
function analyticsEnabled(): boolean {
  return typeof window !== 'undefined' && import.meta.env.VITE_ANALYTICS_ENABLED === 'true';
}

function schedule(cb: () => void): void {
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
}

/**
 * Kicks off Core Web Vitals capture + a single page-view event.
 * No-op on the server and when `VITE_ANALYTICS_ENABLED` isn't `'true'`.
 * Safe to call repeatedly — only the first call does anything.
 */
export function initAnalyticsLazily(): void {
  if (initialized || !analyticsEnabled()) return;
  initialized = true;

  schedule(() => {
    void sendRumEvent({ type: 'pageview' });
    void import('web-vitals')
      .then(({ onLCP, onINP, onCLS, onFCP, onTTFB }) => {
        onLCP((m) => void sendRumEvent({ type: 'vital', name: 'LCP', value: m.value }));
        onINP((m) => void sendRumEvent({ type: 'vital', name: 'INP', value: m.value }));
        onCLS((m) => void sendRumEvent({ type: 'vital', name: 'CLS', value: m.value }));
        onFCP((m) => void sendRumEvent({ type: 'vital', name: 'FCP', value: m.value }));
        onTTFB((m) => void sendRumEvent({ type: 'vital', name: 'TTFB', value: m.value }));
      })
      .catch(() => {
        // Loading web-vitals must never break the app — swallow.
      });
  });
}
