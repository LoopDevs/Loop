import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { isLoopAssetCode } from '@loop/shared';
import type { Route } from './+types/admin.payouts';
import {
  generateIdempotencyKey,
  listPayouts,
  retryPayout,
  type AdminPayoutView,
  type PayoutState,
} from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { useAdminStepUp } from '~/hooks/use-admin-step-up';
import { useStaffRole } from '~/hooks/use-staff-role';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { RequireStaff } from '~/components/features/admin/RequireAdmin';
import { CsvDownloadButton } from '~/components/features/admin/CsvDownloadButton';
import { ReasonDialog } from '~/components/features/admin/ReasonDialog';
import { StepUpModal } from '~/components/features/admin/StepUpModal';
import { Spinner } from '~/components/ui/Spinner';
import { ADMIN_LOCALE } from '~/utils/locale';
import { fmtStroops } from '~/utils/format-stellar';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Payouts — Loop' }];
}

const STATES: readonly (PayoutState | 'all')[] = [
  'all',
  'pending',
  'submitted',
  'confirmed',
  'failed',
];

// ADR-024 §2 / ADR 036 / ADR 031: discriminator filter for the four payout
// flows. `order_cashback` is the order-fulfilment payout; `emission` is the
// admin on-chain backfill (ex-withdrawal — no mirror debit, ADR 036); `burn`
// is the redemption issuer-return; `interest_mint` is the nightly
// issuer-signed interest mint (ADR 031). Treasury wants to drill into one
// without scrolling.
const KINDS = ['all', 'order_cashback', 'emission', 'burn', 'interest_mint'] as const;
type KindFilter = (typeof KINDS)[number];

function kindLabel(k: KindFilter): string {
  if (k === 'all') return 'All kinds';
  if (k === 'order_cashback') return 'Order cashback';
  if (k === 'emission') return 'Emission';
  if (k === 'interest_mint') return 'Interest mint';
  return 'Burn';
}

// LOOP_ASSET_CODES + isLoopAssetCode come from `@loop/shared` —
// see imports at top of file. Kept the narrowing function name in
// scope via the import so the `?assetCode=` URL-param check below
// reads the same as before.

function truncId(s: string): string {
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function statePillClass(s: PayoutState): string {
  switch (s) {
    case 'confirmed':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
    case 'failed':
      return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
    case 'submitted':
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
    case 'pending':
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }
}

/**
 * `/admin/payouts` — drilldown list for ADR 015/016's
 * `pending_payouts`. Filter chips route via `?state=`; failed rows
 * show a Retry button that wraps `resetPayoutToPending`.
 */
// A2-1101: see RequireAdmin.tsx for the shell-gate rationale.
export default function AdminPayoutsRoute(): React.JSX.Element {
  return (
    <RequireStaff minimum="support">
      <AdminPayoutsRouteInner />
    </RequireStaff>
  );
}

function AdminPayoutsRouteInner(): React.JSX.Element {
  // ADR 037: admin-only controls (CSV / money writes) key off this.
  const { isAdminRole } = useStaffRole();
  const [searchParams, setSearchParams] = useSearchParams();
  const stateParam = searchParams.get('state');
  const activeState = STATES.includes(stateParam as PayoutState | 'all')
    ? (stateParam as PayoutState | 'all')
    : 'all';
  // `?assetCode=<code>` drill-down target from /admin/treasury
  // PayoutsByAssetTable. Silently drop typos — prefer a visibly
  // unfiltered list to a 400 the user can't debug from the URL.
  const assetCodeParam = searchParams.get('assetCode');
  const assetCodeFilter =
    assetCodeParam !== null && isLoopAssetCode(assetCodeParam) ? assetCodeParam : undefined;

  // ADR-024 §2 / ADR 036 kind filter — `?kind=order_cashback`, `?kind=emission`, or `?kind=burn`.
  const kindParam = searchParams.get('kind');
  const activeKind: KindFilter = (KINDS as readonly string[]).includes(kindParam ?? '')
    ? (kindParam as KindFilter)
    : 'all';

  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['admin-payouts', activeState, assetCodeFilter ?? null, activeKind],
    queryFn: () =>
      listPayouts({
        limit: 50,
        ...(activeState !== 'all' ? { state: activeState } : {}),
        ...(assetCodeFilter !== undefined ? { assetCode: assetCodeFilter } : {}),
        ...(activeKind !== 'all' ? { kind: activeKind } : {}),
      }),
    retry: shouldRetry,
    staleTime: 10_000,
  });

  // FE-12: track in-flight retries PER-ROW. A single scalar `retryingId`
  // desynced the operator double-submit path — starting a retry on row B
  // overwrote the id, clearing row A's spinner/disabled state while A's
  // request was still in flight (double-submit) and capping the list to
  // one visible loading row. A Set keyed by row id lets each row derive
  // its own loading/disabled state; ids are added on start and removed
  // on settle (success AND error) below.
  const [retryingIds, setRetryingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [retryError, setRetryError] = useState<string | null>(null);
  const [reasonDialogId, setReasonDialogId] = useState<string | null>(null);

  // W-01 / CF-09: payout-retry is a step-up-gated ADR-028 write. Wrap
  // the mutationFn in `runWithStepUp` so a 401 STEP_UP_REQUIRED opens
  // the OTP modal + retries instead of dead-ending on a raw error —
  // matching the credit-adjust / withdrawal forms.
  const stepUp = useAdminStepUp();
  const retryMutation = useMutation({
    // CF-09: the idempotency key is minted once per retry attempt (at
    // reason-confirm time) and carried on `args` so the step-up retry —
    // and any post-completion re-click — re-sends the SAME key. The
    // backend's ADR-017 dedup then collapses the re-fire into a replay
    // rather than a second state transition.
    mutationFn: (args: { id: string; reason: string; idempotencyKey: string }) => {
      // P2-07: echo the amount (Stellar stroops → fmtStroops) + destination
      // of the specific failed row the OTP re-authorizes for submission.
      const row = query.data?.payouts.find((p) => p.id === args.id);
      return stepUp.runWithStepUp(() => retryPayout(args), {
        action: 'Retry payout',
        scope: 'payout-retry',
        ...(row !== undefined
          ? {
              amount: { formatted: fmtStroops(row.amountStroops, row.assetCode) },
              destination: row.toAddress,
            }
          : {}),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-payouts'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-treasury'] });
      setRetryError(null);
    },
    onError: (err) => {
      setRetryError(err instanceof Error ? err.message : 'Retry failed');
    },
    // FE-12: settle the row that actually finished (success OR error) via
    // `variables.id` — never blanket-clear, which would drop the loading
    // state of any sibling retry still in flight.
    onSettled: (_data, _error, variables) => {
      setRetryingIds((prev) => {
        const next = new Set(prev);
        next.delete(variables.id);
        return next;
      });
    },
  });

  // A2-1107: native <dialog>-backed reason prompt replaces the prior
  // `window.prompt` so screen-reader / keyboard users get a real
  // modal with focus trap + ESC dismissal. ADR-017 still requires the
  // 2–500 char reason on every admin write — `<ReasonDialog>` enforces
  // the length contract; the mutation only fires on a non-null resolve.
  const handleRetry = (id: string): void => {
    setReasonDialogId(id);
  };
  const handleReasonResolve = (reason: string | null): void => {
    const id = reasonDialogId;
    setReasonDialogId(null);
    if (id === null || reason === null) return;
    // FE-12: mark THIS row in-flight without disturbing any sibling
    // retry already loading.
    setRetryingIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setRetryError(null);
    // CF-09: one key per action attempt — minted here, reused on the
    // step-up retry inside `runWithStepUp`.
    retryMutation.mutate({ id, reason, idempotencyKey: generateIdempotencyKey() });
  };

  const setState = (next: PayoutState | 'all'): void => {
    setSearchParams((params) => {
      if (next === 'all') params.delete('state');
      else params.set('state', next);
      return params;
    });
  };

  const setKind = (next: KindFilter): void => {
    setSearchParams((params) => {
      if (next === 'all') params.delete('kind');
      else params.set('kind', next);
      return params;
    });
  };

  return (
    <main className="max-w-6xl mx-auto px-6 py-12 space-y-6">
      <ReasonDialog
        open={reasonDialogId !== null}
        title="Reason for retrying this payout?"
        description="2–500 characters. Logged in the admin audit trail (ADR-017)."
        confirmLabel="Retry payout"
        onResolve={handleReasonResolve}
      />
      {stepUp.modalOpen && (
        <StepUpModal onConfirm={stepUp.handleStepUpConfirm} onCancel={stepUp.handleStepUpCancel} />
      )}
      <AdminNav />
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Admin · Payouts</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            Stellar cashback emissions (ADR 015/016). Filter by state; retry failed rows with the
            button at the row level.
          </p>
        </div>
        {/* ADR 037 §3: bulk CSV exports are admin-only. */}
        {isAdminRole ? (
          <CsvDownloadButton
            path="/api/admin/payouts.csv"
            filename={`loop-payouts-${new Date().toISOString().slice(0, 10)}.csv`}
          />
        ) : null}
      </header>

      <nav className="flex flex-wrap gap-2" aria-label="Payout state filter">
        {STATES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setState(s)}
            className={`rounded-full px-3 py-1 text-sm font-medium border ${
              activeState === s
                ? 'border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-gray-900'
                : 'border-gray-200 text-gray-700 bg-white dark:border-gray-700 dark:text-gray-300 dark:bg-gray-900'
            }`}
          >
            {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </nav>

      <nav className="flex flex-wrap gap-2" aria-label="Payout kind filter">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`rounded-full px-3 py-1 text-xs font-medium border ${
              activeKind === k
                ? 'border-purple-700 bg-purple-700 text-white dark:border-purple-400 dark:bg-purple-700 dark:text-white'
                : 'border-gray-200 text-gray-700 bg-white dark:border-gray-700 dark:text-gray-300 dark:bg-gray-900'
            }`}
          >
            {kindLabel(k)}
          </button>
        ))}
      </nav>

      {assetCodeFilter !== undefined ? (
        <div
          role="status"
          className="flex items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
        >
          <span>
            Filtered to asset <code className="font-mono text-xs">{assetCodeFilter}</code>
          </span>
          <button
            type="button"
            onClick={() => {
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.delete('assetCode');
                return next;
              });
            }}
            className="text-xs font-medium underline hover:no-underline"
          >
            Clear
          </button>
        </div>
      ) : null}

      {retryError !== null ? (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
        >
          Retry failed: {retryError}
        </div>
      ) : null}

      {query.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : query.isError ? (
        <p className="text-red-600 dark:text-red-400 py-6">
          Failed to load payouts. You may not be an admin.
        </p>
      ) : query.data.payouts.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-6">
          No payouts in this bucket yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                {[
                  'When',
                  'Kind',
                  'State',
                  'Asset',
                  'Amount',
                  'To',
                  'Tx / Error',
                  'Attempts',
                  '',
                ].map((h) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-start font-medium text-gray-500 dark:text-gray-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-900 bg-white dark:bg-gray-900">
              {query.data.payouts.map((p: AdminPayoutView) => (
                <tr key={p.id}>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700 dark:text-gray-300">
                    <Link
                      to={`/admin/payouts/${p.id}`}
                      className="hover:underline text-blue-600 dark:text-blue-400"
                    >
                      {new Date(p.createdAt).toLocaleString(ADMIN_LOCALE, {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">
                    {p.kind === 'emission'
                      ? 'Emission'
                      : p.kind === 'burn'
                        ? 'Burn'
                        : p.kind === 'interest_mint'
                          ? 'Interest'
                          : 'Cashback'}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statePillClass(p.state)}`}
                    >
                      {p.state}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">
                    {p.assetCode}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                    {fmtStroops(p.amountStroops, p.assetCode)}
                  </td>
                  <td
                    className="px-3 py-2 font-mono text-xs text-gray-600 dark:text-gray-400"
                    title={p.toAddress}
                  >
                    {truncId(p.toAddress)}
                  </td>
                  <td className="px-3 py-2 text-xs max-w-xs">
                    {p.state === 'failed' && p.lastError !== null ? (
                      <span className="text-red-600 dark:text-red-400 line-clamp-2">
                        {p.lastError}
                      </span>
                    ) : p.txHash !== null ? (
                      <span className="font-mono text-gray-600 dark:text-gray-400" title={p.txHash}>
                        {truncId(p.txHash)}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                    {p.attempts}
                  </td>
                  <td className="px-3 py-2">
                    {/* ADR 037 §3: payout retry is a money write —
                        admin-only, hidden for support. */}
                    {isAdminRole && p.state === 'failed' ? (
                      <button
                        type="button"
                        onClick={() => handleRetry(p.id)}
                        disabled={retryingIds.has(p.id)}
                        className="rounded-lg border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
                      >
                        {retryingIds.has(p.id) ? 'Retrying…' : 'Retry'}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
