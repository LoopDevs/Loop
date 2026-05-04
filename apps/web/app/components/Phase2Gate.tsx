import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useAppConfig } from '~/hooks/use-app-config';

/**
 * Tranche-1-launch route gate.
 *
 * Wraps a Phase 2 page (cashback rates, trustlines, wallet
 * settings, cashback settings) and replaces its content with a
 * "coming soon" panel when the backend has set
 * `LOOP_PHASE_1_ONLY=true`. Prefer this over deleting the routes
 * outright — the routing config is build-time, but we want the
 * gate to be a runtime feature flag so flipping it back doesn't
 * require an app store resubmission.
 *
 * Renders the children verbatim when the flag is off (default).
 * Rendering during the initial config-load also passes through —
 * `phase1Only` defaults to `false` in `useAppConfig`, so a
 * /api/config outage won't accidentally hide a live cashback page.
 */
export function Phase2Gate({ children }: { children: ReactNode }): React.ReactElement {
  const { config } = useAppConfig();
  if (!config.phase1Only) {
    return <>{children}</>;
  }
  return (
    <main
      role="main"
      className="mx-auto max-w-2xl px-6 py-16 text-center text-gray-700 dark:text-gray-300"
    >
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Coming soon</h1>
      <p className="mt-3 text-sm">
        This part of Loop is under construction. Cashback rewards, the Stellar wallet, and yield on
        your balance are launching with the next release.
      </p>
      <p className="mt-2 text-sm">
        For now you can browse merchants and buy discounted gift cards from the directory.
      </p>
      <Link
        to="/"
        className="mt-6 inline-flex items-center rounded-lg border border-gray-900 bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 dark:border-white dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
      >
        Back to directory
      </Link>
    </main>
  );
}
