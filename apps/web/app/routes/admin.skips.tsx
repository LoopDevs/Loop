import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import {
  ApiException,
  WATCHER_SKIP_REASONS,
  type AdminWatcherSkipRow,
  type WatcherSkipReason,
  type WatcherSkipStatus,
} from '@loop/shared';
import type { Route } from './+types/admin.skips';
import { shouldRetry } from '~/hooks/query-retry';
import {
  generateIdempotencyKey,
  getWatcherSkip,
  listWatcherSkips,
  reopenWatcherSkip,
} from '~/services/admin';
import { refundDeposit } from '~/services/admin-watcher-skips';
import { useStaffRole } from '~/hooks/use-staff-role';
import { useAdminStepUp } from '~/hooks/use-admin-step-up';
import { StepUpModal } from '~/components/features/admin/StepUpModal';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { RequireStaff } from '~/components/features/admin/RequireAdmin';
import { ReasonDialog } from '~/components/features/admin/ReasonDialog';
import { CopyButton } from '~/components/features/admin/CopyButton';
import { Spinner } from '~/components/ui/Spinner';
import { useUiStore } from '~/stores/ui.store';
import { ADMIN_LOCALE } from '~/utils/locale';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Watcher skips — Loop' }];
}

const STATUSES: ReadonlyArray<WatcherSkipStatus> = [
  'pending',
  'resolved',
  'abandoned',
  'refunding',
  'refunded',
];
// AUDIT-2 finding C review nit: this used to be a hardcoded literal
// list that drifted behind `@loop/shared`'s `WATCHER_SKIP_REASONS`
// (missing `order_gone` for one PR cycle, then `unrecognized_deposit`
// for this one) — the filter `<select>` silently couldn't offer the
// newest reason and a direct `?reason=<new>` URL degraded to
// "no filter" instead of filtering. Deriving from the shared constant
// closes this drift class for good: a new reason value now shows up
// here automatically, no companion edit required.
const REASONS: ReadonlyArray<WatcherSkipReason> = WATCHER_SKIP_REASONS;

const STATUS_CLASSES: Record<WatcherSkipStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  resolved: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  abandoned: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  // A6: refund lifecycle for an abandoned late deposit.
  refunding: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  refunded: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300',
};

function isStatus(v: string | null): v is WatcherSkipStatus {
  return v !== null && (STATUSES as readonly string[]).includes(v);
}
function isReason(v: string | null): v is WatcherSkipReason {
  return v !== null && (REASONS as readonly string[]).includes(v);
}

/**
 * `/admin/skips` — payment-watcher skip-row browser (ADR 037 §4).
 *
 * First ops surface over `payment_watcher_skips`: the deposits the
 * payment watcher skipped before advancing its Horizon cursor
 * (comprehensive audit 2026-06-11 CRIT #1/#2). The sweep re-drives
 * `pending` rows on its own; `abandoned` rows (attempt budget
 * exhausted) sit here until a human re-opens them — that re-open is
 * the support-allowed delivery-unsticking action this page exists
 * for.
 *
 * Support-visible (reads + the re-open action only — ADR 037 §3).
 */
export default function AdminSkipsRoute(): React.JSX.Element {
  return (
    <RequireStaff minimum="support">
      <AdminSkipsRouteInner />
    </RequireStaff>
  );
}

/** Page size for the keyset walk (backend default; max 100). */
const PAGE_SIZE = 20;

function AdminSkipsRouteInner(): React.JSX.Element {
  const queryClient = useQueryClient();
  const addToast = useUiStore((s) => s.addToast);
  const [searchParams, setSearchParams] = useSearchParams();
  const statusParam = searchParams.get('status');
  const reasonParam = searchParams.get('reason');
  const status = isStatus(statusParam) ? statusParam : undefined;
  const reason = isReason(reasonParam) ? reasonParam : undefined;

  // Keyset cursor stack (the backend paginates on `before`, the same
  // convention as /api/admin/orders — there is no page number). The
  // top of the stack is the cursor for the page on screen; an empty
  // stack is the newest page.
  const [cursors, setCursors] = useState<string[]>([]);
  const before = cursors.length > 0 ? cursors[cursors.length - 1] : undefined;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reopenTarget, setReopenTarget] = useState<AdminWatcherSkipRow | null>(null);
  // A6 / ADR-017: the refund now carries an audited reason too, so it
  // takes the same ReasonDialog target as reopen (above).
  const [refundTarget, setRefundTarget] = useState<AdminWatcherSkipRow | null>(null);
  // A6: refund is an admin-tier + step-up action; support sees the tab
  // but not the Refund button.
  const { isAdminRole } = useStaffRole();
  const stepUp = useAdminStepUp();

  const query = useQuery({
    queryKey: ['admin-watcher-skips', status ?? null, reason ?? null, before ?? null],
    queryFn: () =>
      listWatcherSkips({
        ...(status !== undefined ? { status } : {}),
        ...(reason !== undefined ? { reason } : {}),
        ...(before !== undefined ? { before } : {}),
        limit: PAGE_SIZE,
      }),
    retry: shouldRetry,
    staleTime: 10_000,
  });

  const reopen = useMutation({
    mutationFn: (args: { paymentId: string; reason: string }) => reopenWatcherSkip(args),
    onSuccess: (envelope, args) => {
      addToast(
        envelope.audit.replayed
          ? `Reopen replayed — skip row ${args.paymentId} was already re-queued.`
          : `Skip row ${args.paymentId} re-opened — the replay sweep re-evaluates it on its next tick.`,
        'success',
      );
      void queryClient.invalidateQueries({
        predicate: (q) => String(q.queryKey[0]).startsWith('admin-watcher-skip'),
      });
    },
    onError: (err) => {
      addToast(
        err instanceof ApiException ? err.message : 'Failed to re-open the skip row.',
        'error',
      );
    },
  });

  // A6: refund an abandoned late deposit to its sender. Full ADR-017
  // admin write now — carries an audited reason + a per-click
  // Idempotency-Key, returning the `{ result, audit }` envelope. The
  // key is minted ONCE at `.mutate()` time (below) and threaded through
  // `refundDeposit` so the step-up-retry re-run of this same closure
  // replays the stored snapshot instead of double-paying (CF-09).
  const refund = useMutation({
    mutationFn: (args: { paymentId: string; reason: string; idempotencyKey: string }) =>
      // P2-07: echo which deposit the OTP refunds to its on-chain sender.
      // The amount is server-side; the payment id is the identifying
      // detail on the client.
      stepUp.runWithStepUp(
        () =>
          refundDeposit({
            paymentId: args.paymentId,
            reason: args.reason,
            idempotencyKey: args.idempotencyKey,
          }),
        {
          action: 'Refund deposit to sender',
          scope: 'deposit-refund',
          destination: args.paymentId,
        },
      ),
    onSuccess: (envelope) => {
      const res = envelope.result;
      addToast(
        res.status === 'already_refunded'
          ? `Deposit ${res.paymentId} was already refunded (tx ${res.txHash.slice(0, 8)}…).`
          : `Deposit ${res.paymentId} refunded to sender (tx ${res.txHash.slice(0, 8)}…).`,
        'success',
      );
      void queryClient.invalidateQueries({
        predicate: (q) => String(q.queryKey[0]).startsWith('admin-watcher-skip'),
      });
    },
    onError: (err) => {
      addToast(err instanceof ApiException ? err.message : 'Refund failed.', 'error');
    },
  });

  const setFilter = (key: 'status' | 'reason', value: string): void => {
    setSearchParams((params) => {
      if (value.length === 0) params.delete(key);
      else params.set(key, value);
      return params;
    });
    setCursors([]);
  };

  const handleReopenReason = (reasonText: string | null): void => {
    const target = reopenTarget;
    setReopenTarget(null);
    if (reasonText === null || target === null) return;
    reopen.mutate({ paymentId: target.paymentId, reason: reasonText });
  };

  const handleRefundReason = (reasonText: string | null): void => {
    const target = refundTarget;
    setRefundTarget(null);
    if (reasonText === null || target === null) return;
    // Mint the key here (mutate-time), NOT inside `refundDeposit`, so a
    // step-up retry of the same mutation closure reuses it verbatim.
    refund.mutate({
      paymentId: target.paymentId,
      reason: reasonText,
      idempotencyKey: generateIdempotencyKey(),
    });
  };

  const rows = query.data?.rows ?? [];
  const lastRow = rows.length > 0 ? rows[rows.length - 1] : undefined;

  return (
    <main className="max-w-5xl mx-auto px-6 py-12 space-y-6">
      <AdminNav />
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Watcher skips</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Deposits the payment watcher skipped before advancing its Horizon cursor. The replay sweep
          re-drives <code className="font-mono text-xs">pending</code> rows automatically;{' '}
          <code className="font-mono text-xs">abandoned</code> rows exhausted their attempt budget
          and need a human re-open.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-4">
        <label className="space-y-1 text-xs font-medium text-gray-600 dark:text-gray-400">
          Status
          <select
            value={status ?? ''}
            onChange={(e) => setFilter('status', e.target.value)}
            aria-label="Filter by status"
            className="block rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs font-medium text-gray-600 dark:text-gray-400">
          Reason
          <select
            value={reason ?? ''}
            onChange={(e) => setFilter('reason', e.target.value)}
            aria-label="Filter by reason"
            className="block rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          >
            <option value="">All reasons</option>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>

      {query.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : query.isError ? (
        <p className="text-red-600 dark:text-red-400 py-6">Failed to load watcher skips.</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-sm text-gray-500 dark:text-gray-400">
          No skip rows match the current filters — the watcher hasn&rsquo;t had to skip anything
          here.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-800">
            <thead className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                {['Payment', 'Memo', 'Order', 'Reason', 'Attempts', 'Status', 'Updated', ''].map(
                  (h, i) => (
                    <th
                      key={`${h}-${String(i)}`}
                      className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400"
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-900 dark:bg-gray-900">
              {rows.map((row) => (
                <tr key={row.paymentId}>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedId(selectedId === row.paymentId ? null : row.paymentId)
                      }
                      className="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
                      aria-label={`Toggle detail for skip ${row.paymentId}`}
                    >
                      {row.paymentId}
                    </button>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-300">
                    {row.memo}
                  </td>
                  <td className="px-3 py-2">
                    {row.orderId !== null ? (
                      <Link
                        to={`/admin/orders/${row.orderId}`}
                        className="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {row.orderId.slice(0, 8)}…
                      </Link>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-700 dark:text-gray-300">
                    {row.reason}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-gray-900 dark:text-white">
                    {row.attempts}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_CLASSES[row.status]}`}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-600 dark:text-gray-400">
                    {new Date(row.updatedAt).toLocaleString(ADMIN_LOCALE, {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {row.status === 'abandoned' ? (
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setReopenTarget(row)}
                          disabled={reopen.isPending}
                          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
                        >
                          Reopen
                        </button>
                        {isAdminRole ? (
                          <button
                            type="button"
                            onClick={() => setRefundTarget(row)}
                            disabled={refund.isPending}
                            title="Refund this deposit to its on-chain sender"
                            className="rounded-lg border border-teal-300 bg-teal-50 px-3 py-1.5 text-xs font-medium text-teal-800 hover:bg-teal-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-teal-800 dark:bg-teal-900/30 dark:text-teal-300 dark:hover:bg-teal-900/50"
                          >
                            {refund.isPending ? 'Refunding…' : 'Refund'}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedId !== null ? <SkipDetail paymentId={selectedId} /> : null}

      <nav className="flex items-center justify-between" aria-label="Skips pagination">
        <button
          type="button"
          onClick={() => setCursors((stack) => stack.slice(0, -1))}
          disabled={cursors.length === 0}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          ← Newer
        </button>
        <span className="text-xs text-gray-500 dark:text-gray-400">Page {cursors.length + 1}</span>
        <button
          type="button"
          onClick={() => {
            if (lastRow !== undefined) setCursors((stack) => [...stack, lastRow.createdAt]);
          }}
          disabled={lastRow === undefined || rows.length < PAGE_SIZE}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Older →
        </button>
      </nav>

      <ReasonDialog
        open={reopenTarget !== null}
        title={
          reopenTarget !== null
            ? `Reason for re-opening skip ${reopenTarget.paymentId}?`
            : 'Reason for re-opening?'
        }
        description="The replay sweep re-evaluates the row with a fresh attempt budget. The reason lands in the audit trail and the Discord notification."
        confirmLabel="Reopen"
        onResolve={handleReopenReason}
      />

      {/* A6 / ADR-017: the refund captures its audited reason the same
          way reopen does, then runs the step-up dance below. */}
      <ReasonDialog
        open={refundTarget !== null}
        title={
          refundTarget !== null
            ? `Reason for refunding deposit ${refundTarget.paymentId}?`
            : 'Reason for refunding?'
        }
        description="Submits an on-chain refund-to-sender for this abandoned late deposit. The reason lands in the audit trail and the Discord notification."
        confirmLabel="Refund"
        onResolve={handleRefundReason}
      />

      {/* A6: step-up dance for the admin refund action. */}
      {stepUp.modalOpen && (
        <StepUpModal onConfirm={stepUp.handleStepUpConfirm} onCancel={stepUp.handleStepUpCancel} />
      )}
    </main>
  );
}

/**
 * Drawer-style detail for one skip row: the snapshotted Horizon
 * payment (the exact record the sweep replays) + the last replay
 * error. Rendered inline under the table on paymentId click.
 */
function SkipDetail({ paymentId }: { paymentId: string }): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-watcher-skip', paymentId],
    queryFn: () => getWatcherSkip(paymentId),
    retry: shouldRetry,
    staleTime: 10_000,
  });

  return (
    <section
      aria-label={`Skip detail ${paymentId}`}
      className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"
    >
      <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white inline-flex items-center gap-1">
          Skip <code className="font-mono text-sm">{paymentId}</code>
          <CopyButton text={paymentId} label="Copy payment id" />
        </h2>
      </header>
      {query.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : query.isError ? (
        <p className="px-6 py-6 text-sm text-red-600 dark:text-red-400">
          Failed to load skip detail.
        </p>
      ) : (
        <div className="space-y-4 px-6 py-5 text-sm">
          {query.data.lastError !== null ? (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
                Last error
              </h3>
              <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-900/20 dark:text-red-300">
                {query.data.lastError}
              </pre>
            </div>
          ) : null}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Horizon payment snapshot
            </h3>
            <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-800 dark:bg-gray-950 dark:text-gray-300">
              {JSON.stringify(query.data.payment, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </section>
  );
}
