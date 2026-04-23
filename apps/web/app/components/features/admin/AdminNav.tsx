/**
 * Shared tab nav for the admin panel (ADR 011 / 015).
 *
 * Top-level navigation between the three admin surfaces:
 *   - /admin/cashback  — per-merchant cashback-split config + history
 *   - /admin/treasury  — credit-ledger + LOOP liabilities + operator pool
 *   - /admin/payouts   — pending-payouts backlog with retry
 *
 * Rendered at the top of every admin page so ops can flip between them
 * without going back to the URL bar. Active tab is underlined + bold
 * based on `useLocation` — React Router keeps this in sync with the
 * current route without a prop drill.
 *
 * Also carries a compact CTX supplier-pool health pill (ADR 013). The
 * pool is the set of service accounts Loop fronts to CTX — open
 * circuits mean the supplier is degraded and user-facing order flows
 * will 503. The pill reads from the same `/api/admin/treasury`
 * snapshot the Treasury page uses, so a TanStack shared query means
 * both surfaces share the fetch + cache line.
 *
 * Deliberately no auth gate inside the component — each admin page
 * already gates on `requireAdmin` at the backend and renders a
 * "Not authorised" body on 401/404. The nav itself is safe to render
 * for any caller; non-admins just can't follow the links usefully.
 */
import { Link, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';
import { getTreasurySnapshot, type TreasurySnapshot } from '~/services/admin';

const TABS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/admin/cashback', label: 'Cashback' },
  { href: '/admin/treasury', label: 'Treasury' },
  { href: '/admin/payouts', label: 'Payouts' },
  { href: '/admin/orders', label: 'Orders' },
  { href: '/admin/merchants', label: 'Merchants' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/operators', label: 'Operators' },
  { href: '/admin/assets', label: 'Assets' },
  { href: '/admin/audit', label: 'Audit' },
];

/**
 * Summarises an operator-pool snapshot into one of four display
 * states. The definition errs on the side of flagging anything
 * non-green — ops needs to notice degradation immediately, so a
 * half-open circuit is already "degraded", not "healthy-with-an-
 * asterisk".
 */
type CtxStatus = 'healthy' | 'degraded' | 'unavailable' | 'unconfigured' | 'unknown';

export function operatorPoolStatus(
  operatorPool: TreasurySnapshot['operatorPool'] | undefined,
): CtxStatus {
  if (operatorPool === undefined) return 'unknown';
  if (operatorPool.size === 0) return 'unconfigured';
  let anyOpen = false;
  let anyHalfOpen = false;
  for (const op of operatorPool.operators) {
    if (op.state === 'open') anyOpen = true;
    else if (op.state === 'half_open') anyHalfOpen = true;
  }
  if (anyOpen) return 'unavailable';
  if (anyHalfOpen) return 'degraded';
  return 'healthy';
}

const STATUS_UI: Record<
  CtxStatus,
  { label: string; classes: string; dot: string; description: string }
> = {
  healthy: {
    label: 'CTX healthy',
    classes:
      'border-green-200 bg-green-50 text-green-800 dark:border-green-900/60 dark:bg-green-900/20 dark:text-green-300',
    dot: 'bg-green-500',
    description: 'All operator circuits closed. Supplier calls are flowing.',
  },
  degraded: {
    label: 'CTX degraded',
    classes:
      'border-yellow-200 bg-yellow-50 text-yellow-800 dark:border-yellow-900/60 dark:bg-yellow-900/20 dark:text-yellow-300',
    dot: 'bg-yellow-500',
    description: 'At least one operator is in HALF_OPEN probe state.',
  },
  unavailable: {
    label: 'CTX unavailable',
    classes:
      'border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-300',
    dot: 'bg-red-500',
    description: 'At least one operator circuit is OPEN. Orders may 503.',
  },
  unconfigured: {
    label: 'CTX unconfigured',
    classes:
      'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-300',
    dot: 'bg-gray-400',
    description: 'CTX_OPERATOR_POOL is empty — no supplier calls can run.',
  },
  unknown: {
    label: 'CTX status loading',
    classes:
      'border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-400',
    dot: 'bg-gray-300',
    description: 'Fetching the treasury snapshot.',
  },
};

function CtxStatusPill({ status }: { status: CtxStatus }): React.JSX.Element {
  const ui = STATUS_UI[status];
  return (
    <Link
      to="/admin/treasury"
      title={ui.description}
      aria-label={`${ui.label}. ${ui.description}`}
      className={`hidden sm:inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:opacity-90 ${ui.classes}`}
    >
      <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${ui.dot}`} />
      {ui.label}
    </Link>
  );
}

/**
 * Parses the bigint-as-string `payouts.failed` count into a number.
 * Returns 0 for anything unparseable — the badge defaults to hidden,
 * not a scary placeholder. Cap at 99+ so the pill stays compact when
 * a backlog spirals.
 */
export function failedPayoutsCount(payouts: TreasurySnapshot['payouts'] | undefined): number {
  if (payouts === undefined) return 0;
  const n = Number(payouts.failed);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function FailedPayoutsBadge({ count }: { count: number }): React.JSX.Element {
  const label = count > 99 ? '99+' : String(count);
  return (
    <Link
      to="/admin/payouts?state=failed"
      title={`${count} pending payout${count === 1 ? '' : 's'} in the failed state. Click to review and retry.`}
      aria-label={`${count} failed payouts — click to review`}
      className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-medium text-red-800 transition-colors hover:opacity-90 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-300"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        className="h-3 w-3"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 9v3.5M12 16h.01M4.93 19h14.14a2 2 0 001.74-3l-7.07-12a2 2 0 00-3.48 0L3.2 16a2 2 0 001.73 3z"
        />
      </svg>
      {label} failed
    </Link>
  );
}

export function AdminNav(): React.JSX.Element {
  const { pathname } = useLocation();
  const { isAuthenticated } = useAuth();
  // Share the `['admin-treasury']` cache key with /admin/treasury so
  // the pill's fetch deduplicates with the page's fetch — loading
  // either surface warms the other. 30s stale matches the
  // operator-pool refresh cadence, which is driven by the
  // request-side circuit breaker reset window.
  const snapshotQuery = useQuery<TreasurySnapshot, Error>({
    queryKey: ['admin-treasury'],
    queryFn: getTreasurySnapshot,
    enabled: isAuthenticated,
    staleTime: 30_000,
    retry: shouldRetry,
  });

  // Non-admin callers hit 401/404 here. Hide the pill silently in
  // that case — rendering "unknown" would be misleading and the
  // admin page body below already surfaces the denial.
  const denied =
    snapshotQuery.error instanceof ApiException &&
    (snapshotQuery.error.status === 401 || snapshotQuery.error.status === 404);
  const status = denied ? null : operatorPoolStatus(snapshotQuery.data?.operatorPool);
  const failedCount = denied ? 0 : failedPayoutsCount(snapshotQuery.data?.payouts);

  return (
    <nav
      aria-label="Admin sections"
      className="mb-6 flex items-center justify-between gap-3 border-b border-gray-200 dark:border-gray-800"
    >
      <div className="flex items-center gap-1">
        {TABS.map((tab) => {
          // Use startsWith so `/admin/payouts/abc` still highlights
          // `Payouts`. The routes themselves never share a prefix with
          // each other so false-positive overlap is a non-issue.
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.href}
              to={tab.href}
              aria-current={active ? 'page' : undefined}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                active
                  ? 'border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300'
                  : 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
      {(status !== null || failedCount > 0) && (
        <div className="flex items-center gap-2 pb-2">
          {/* Failed-payouts badge sits to the left of the CTX pill so
              the user's eye lands on it first when a payout is stuck
              — it's a direct ops-action trigger, whereas the CTX pill
              is closer to a health indicator. */}
          {failedCount > 0 && <FailedPayoutsBadge count={failedCount} />}
          {status !== null && <CtxStatusPill status={status} />}
        </div>
      )}
    </nav>
  );
}
