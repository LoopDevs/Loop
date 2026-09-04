import { Fragment, useMemo, useState } from 'react';
import { RequireAdmin } from '~/components/features/admin/RequireAdmin';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type { Route } from './+types/admin.cashback';
import { useAllMerchants } from '~/hooks/use-merchants';
import {
  cashbackConfigHistory,
  listCashbackConfigs,
  upsertCashbackConfig,
  type MerchantCashbackConfig,
  type MerchantCashbackConfigHistoryEntry,
} from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { CsvDownloadButton } from '~/components/features/admin/CsvDownloadButton';
import { MerchantResyncButton } from '~/components/features/admin/MerchantResyncButton';
import { ReasonDialog } from '~/components/features/admin/ReasonDialog';
import { StepUpModal } from '~/components/features/admin/StepUpModal';
import { useAdminStepUp } from '~/hooks/use-admin-step-up';
import { MerchantStatsTable } from '~/components/features/admin/MerchantStatsTable';
import { Button } from '~/components/ui/Button';
import { Spinner } from '~/components/ui/Spinner';
import { formatDateTime } from '~/i18n/format';
import { ADMIN_LOCALE } from '~/utils/locale';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Cashback — Loop' }];
}

interface RowDraft {
  userCashbackPct: string;
}

/**
 * `/admin/cashback` — admin-only surface for the per-merchant user
 * cashback share (ADR 011, reshaped by ADR 052). One percentage per
 * merchant: the share of Loop's CTX margin handed to the customer
 * (0 = Loop keeps the whole spread, 100 = all of it goes to the
 * customer — delivered as CTX's native checkout discount). Renders
 * every merchant from the public catalog alongside its current
 * config (if any); editing a row shows a Save button that calls
 * `/api/admin/merchant-cashback-configs/:id`.
 *
 * Access control: the backend rejects non-admin calls with 404, so
 * an accidental navigation shows an empty table + a "not authorised"
 * banner rather than an admin-shaped screen that doesn't work. The
 * frontend does not gate on is_admin locally — it's not the source
 * of truth (see `requireAdmin` in the backend).
 */
// A2-1101: see RequireAdmin.tsx for the shell-gate rationale.
export default function AdminCashbackRoute(): React.JSX.Element {
  return (
    <RequireAdmin>
      <AdminCashbackRouteInner />
    </RequireAdmin>
  );
}

function AdminCashbackRouteInner(): React.JSX.Element {
  const { merchants } = useAllMerchants();
  const queryClient = useQueryClient();

  const configsQuery = useQuery({
    queryKey: ['admin-cashback-configs'],
    queryFn: listCashbackConfigs,
    retry: shouldRetry,
    staleTime: 0,
  });

  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  // A2-1107: per-merchant reason-prompt target. `null` → dialog closed;
  // a merchantId → dialog open with the matching merchant's name in the
  // title. Single dialog instance reused across rows.
  const [reasonTarget, setReasonTarget] = useState<{ id: string; name: string } | null>(null);
  // Expanded-row set for the inline history drawer (ADR 011). Each
  // merchantId in the set renders an extra tbody row below its main
  // row with the most-recent 50 audit snapshots. The drawer is a
  // separate query keyed on the id — lazy-loaded so we don't fire N
  // GETs on the initial page render.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (merchantId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(merchantId)) next.delete(merchantId);
      else next.add(merchantId);
      return next;
    });
  };

  const configByMerchant = useMemo(() => {
    const map = new Map<string, MerchantCashbackConfig>();
    for (const c of configsQuery.data?.configs ?? []) map.set(c.merchantId, c);
    return map;
  }, [configsQuery.data]);

  const stepUp = useAdminStepUp();
  const saveMutation = useMutation({
    mutationFn: async (args: { merchantId: string; draft: RowDraft; reason: string }) => {
      const userCashbackPct = Number(args.draft.userCashbackPct);
      // ADR 028: step-up gated (sets future emission rates). The hook
      // opens <StepUpModal /> on STEP_UP_REQUIRED and retries once.
      return stepUp.runWithStepUp(
        () =>
          upsertCashbackConfig(args.merchantId, {
            userCashbackPct,
            reason: args.reason,
          }),
        // P2-07: no single money amount (a percentage), so echo the
        // share being authorized + the target merchant rather than a
        // blank confirmation.
        {
          action: `Set user cashback — ${userCashbackPct}% of margin`,
          scope: 'cashback-config',
          destination: args.merchantId,
        },
      );
    },
    onSuccess: async () => {
      setSaveError(null);
      await queryClient.invalidateQueries({ queryKey: ['admin-cashback-configs'] });
    },
    onError: (err) => {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    },
  });

  // 401/404 handling — backend returns 404 for non-admin users by
  // design (don't leak the surface). Treat both as "you're not
  // allowed here".
  const denied =
    configsQuery.error instanceof ApiException &&
    (configsQuery.error.status === 401 || configsQuery.error.status === 404);

  if (configsQuery.isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10 flex items-center gap-3">
        <Spinner />
        <span className="text-sm text-gray-600 dark:text-gray-300">Loading config…</span>
      </div>
    );
  }

  if (denied) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-bold mb-4">Not authorised</h1>
        <p className="text-gray-500 dark:text-gray-400">
          This page is only available to Loop admins.
        </p>
      </div>
    );
  }

  const getDraft = (cfg: MerchantCashbackConfig | undefined, merchantId: string): RowDraft => {
    const d = drafts[merchantId];
    if (d !== undefined) return d;
    return {
      userCashbackPct: cfg?.userCashbackPct ?? '0.00',
    };
  };

  // Numeric comparison, not string comparison: the inputs are free
  // text, so "5" vs a stored "5.00" is the same value and must not
  // read as dirty (comprehensive-audit 2026-06-11, P10). NaN (draft
  // mid-edit, e.g. "5.") compares unequal to everything, which keeps
  // Save enabled while the user types — the backend validates the
  // final shape.
  const pctChanged = (draft: string, stored: string | undefined): boolean =>
    Number(draft) !== Number(stored ?? '0.00');

  const isDirty = (cfg: MerchantCashbackConfig | undefined, merchantId: string): boolean => {
    const d = drafts[merchantId];
    if (d === undefined) return false;
    return pctChanged(d.userCashbackPct, cfg?.userCashbackPct);
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      {stepUp.modalOpen ? (
        <StepUpModal onConfirm={stepUp.handleStepUpConfirm} onCancel={stepUp.handleStepUpCancel} />
      ) : null}
      <ReasonDialog
        open={reasonTarget !== null}
        title={
          reasonTarget !== null
            ? `Reason for updating ${reasonTarget.name}'s user cashback?`
            : 'Reason'
        }
        description="2–500 characters. Logged in the cashback-config audit trail (ADR-011)."
        confirmLabel="Save"
        onResolve={(reason) => {
          const target = reasonTarget;
          setReasonTarget(null);
          if (target === null || reason === null) return;
          const draft = drafts[target.id];
          if (draft === undefined) return;
          saveMutation.mutate({ merchantId: target.id, draft, reason });
        }}
      />
      <AdminNav />
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">
            Cashback configuration
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            One percentage per merchant: the share of Loop&rsquo;s margin given to the customer as
            an instant CTX checkout discount (0% = Loop keeps the whole spread, 100% = all of it
            goes to the customer). Edits apply to new orders; in-flight orders keep their pinned
            share.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          {/* Manual CTX catalog resync (ADR 011). Natural home here —
              the page edits configs keyed on merchant id, so after a
              new merchant lands upstream the admin wants to see it
              appear in this table without waiting 6h for the scheduled
              sweep. */}
          <MerchantResyncButton />
          {/* Tier-3 CSV snapshot of current commercial terms
              (ADR 011 / 018 / #579). Ops pulls this for finance /
              audit reviews — the JSON list above is the live view,
              this is the spreadsheet-friendly snapshot. */}
          <CsvDownloadButton
            path="/api/admin/merchant-cashback-configs.csv"
            filename={`cashback-configs-${new Date().toISOString().slice(0, 10)}.csv`}
            label="Configs CSV"
          />
        </div>
      </div>

      {saveError !== null && (
        <div className="mb-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
          {saveError}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/40 text-start text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <tr>
              <th className="px-3 py-2">Merchant</th>
              <th className="px-3 py-2">User cashback (% of margin)</th>
              <th className="px-3 py-2">Last edit</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {merchants.map((m) => {
              const cfg = configByMerchant.get(m.id);
              const draft = getDraft(cfg, m.id);
              const dirty = isDirty(cfg, m.id);
              const saving = saveMutation.isPending && saveMutation.variables?.merchantId === m.id;
              return (
                <Fragment key={m.id}>
                  <tr className="border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900/30">
                    <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">
                      <div>{m.name}</div>
                    </td>
                    <td className="px-3 py-2">
                      <PctInput
                        value={draft.userCashbackPct}
                        onChange={(v) =>
                          setDrafts((d) => ({ ...d, [m.id]: { ...draft, userCashbackPct: v } }))
                        }
                      />
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                      {cfg === undefined
                        ? '—'
                        : formatDateTime(cfg.updatedAt, ADMIN_LOCALE, { dateStyle: 'medium' })}
                    </td>
                    <td className="px-3 py-2 flex items-center gap-2">
                      <Button
                        variant="secondary"
                        disabled={!dirty || saving}
                        onClick={() => {
                          // A2-502: ADR-017 requires a reason on every
                          // admin mutation. A2-1107: opens the shared
                          // ReasonDialog instead of window.prompt for
                          // a11y / focus trap / ESC cancel.
                          setSaveError(null);
                          setReasonTarget({ id: m.id, name: m.name });
                        }}
                      >
                        {saving ? 'Saving…' : 'Save'}
                      </Button>
                      {/* Only expose the history button once a config
                        has been written; there's no prior-row audit
                        for an unconfigured merchant. */}
                      {cfg !== undefined && (
                        <button
                          type="button"
                          onClick={() => toggleExpanded(m.id)}
                          aria-expanded={expanded.has(m.id)}
                          aria-controls={`history-${m.id}`}
                          className="text-xs font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                        >
                          {expanded.has(m.id) ? 'Hide history' : 'History'}
                        </button>
                      )}
                    </td>
                  </tr>
                  {cfg !== undefined && expanded.has(m.id) ? (
                    <HistoryDrawerRow merchantId={m.id} />
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <section className="mt-8 rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <header className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4 dark:border-gray-800">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              Per-merchant stats (31d)
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Fulfilled-order volume broken down by merchant (ADR 011 / 052). Tuning a
              merchant&rsquo;s cashback share? Watch the commission column here for impact — small %
              changes on a high-volume merchant outweigh big tweaks on the long tail.
            </p>
          </div>
          {/* Two exports — both live on this section since it's the
              page's finance-/ops-export row. Activity = daily × per-
              currency accrual (month-end reconciliation), merchant-
              stats = flat per-merchant ranking (CTX negotiation deck).
              The buttons each carry their own label so ops doesn't
              click the wrong one. */}
          <div className="flex flex-col sm:flex-row gap-2 shrink-0">
            <CsvDownloadButton
              path="/api/admin/cashback-activity.csv"
              filename={`cashback-activity-${new Date().toISOString().slice(0, 10)}.csv`}
              label="Daily accrual CSV"
            />
            <CsvDownloadButton
              path="/api/admin/merchant-stats.csv"
              filename={`merchant-stats-${new Date().toISOString().slice(0, 10)}.csv`}
              label="Per-merchant CSV"
            />
          </div>
        </header>
        <div className="px-6 py-5">
          <MerchantStatsTable />
        </div>
      </section>
    </div>
  );
}

/**
 * Inline history drawer for a single merchant cashback-config row
 * (ADR 011). Lazy-loaded — rendered only when the user expands the
 * row, so the initial /admin/cashback page load doesn't fire a GET
 * per merchant. Uses its own `['admin-cashback-history', id]` cache
 * key so two expand-cycles on the same row don't refetch.
 *
 * Renders the prior-row snapshots (not the current row) — each entry
 * represents what the config looked like BEFORE the change at
 * `changedAt` happened. `changedBy` is the admin user id that triggered
 * the change.
 */
function HistoryDrawerRow({ merchantId }: { merchantId: string }): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-cashback-history', merchantId],
    queryFn: () => cashbackConfigHistory(merchantId),
    retry: shouldRetry,
    staleTime: 0,
  });

  return (
    <tr id={`history-${merchantId}`} className="bg-gray-50 dark:bg-gray-900/30">
      <td colSpan={4} className="px-3 py-3">
        {query.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <Spinner /> Loading audit trail…
          </div>
        ) : query.isError ? (
          <p className="text-xs text-red-600 dark:text-red-400">
            Couldn&rsquo;t load history. Try closing and reopening.
          </p>
        ) : (query.data?.history ?? []).length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            No prior snapshots — this merchant&rsquo;s config is the first recorded state.
          </p>
        ) : (
          <HistoryTable rows={query.data?.history ?? []} />
        )}
      </td>
    </tr>
  );
}

// Admin/ops surface: route the config-change audit timestamp through the shared
// `i18n/format#formatDateTime` seam pinned to `ADMIN_LOCALE` (en-US), like the
// sibling merchant config-history table (admin.merchants.$merchantId) — NOT the
// route locale, so the ops team reads one stable format (A2-1521). This replaces
// a bare `toLocaleString()` (host locale AND host default full date+time+seconds);
// `dateStyle:'medium' + timeStyle:'short'` keeps the year the bare output showed
// while dropping the noise seconds (P2-DATE-SWEEP2 consolidation).
const HISTORY_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  dateStyle: 'medium',
  timeStyle: 'short',
};

function HistoryTable({ rows }: { rows: MerchantCashbackConfigHistoryEntry[] }): React.JSX.Element {
  return (
    <table className="w-full text-xs">
      <thead className="text-start text-gray-500 dark:text-gray-400">
        <tr>
          <th className="pb-1 font-medium">Changed</th>
          <th className="pb-1 font-medium">By</th>
          <th className="pb-1 font-medium">User cashback</th>
          <th className="pb-1 font-medium">Active</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="text-gray-700 dark:text-gray-200">
            <td className="py-1 pe-2 whitespace-nowrap">
              {formatDateTime(row.changedAt, ADMIN_LOCALE, HISTORY_DATE_OPTIONS)}
            </td>
            <td className="py-1 pe-2 font-mono text-[11px]">{row.changedBy}</td>
            <td className="py-1 pe-2">{row.userCashbackPct}%</td>
            <td className="py-1 pe-2">{row.active ? 'Yes' : 'No'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PctInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): React.JSX.Element {
  return (
    <input
      type="number"
      inputMode="decimal"
      step="0.01"
      min="0"
      max="100"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-24 px-2 py-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-white"
    />
  );
}
