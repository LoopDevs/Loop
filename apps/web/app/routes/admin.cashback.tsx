import { Fragment, useMemo, useState } from 'react';
import { RequireAdmin } from '~/components/features/admin/RequireAdmin';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiException, formatMinorCurrency } from '@loop/shared';
import type { Route } from './+types/admin.cashback';
import { useAllMerchants } from '~/hooks/use-merchants';
import {
  cashbackConfigHistory,
  listCashbackConfigs,
  listMerchantFlows,
  upsertCashbackConfig,
  type MerchantCashbackConfig,
  type MerchantCashbackConfigHistoryEntry,
  type MerchantFlow,
} from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { CsvDownloadButton } from '~/components/features/admin/CsvDownloadButton';
import { MerchantResyncButton } from '~/components/features/admin/MerchantResyncButton';
import { ReasonDialog } from '~/components/features/admin/ReasonDialog';
import { MerchantStatsTable } from '~/components/features/admin/MerchantStatsTable';
import { MerchantsFlywheelShareCard } from '~/components/features/admin/MerchantsFlywheelShareCard';
import { Button } from '~/components/ui/Button';
import { Spinner } from '~/components/ui/Spinner';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Cashback — Loop' }];
}

interface RowDraft {
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
}

/**
 * `/admin/cashback` — admin-only surface for per-merchant cashback
 * splits (ADR 011). Renders every merchant from the public catalog
 * alongside its current config (if any); editing a row shows a Save
 * button that calls `/api/admin/merchant-cashback-configs/:id`.
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

  // Per-merchant fulfilled-order flow. Loaded in parallel with
  // configs; the row join is best-effort so a 403 on this query
  // (admin not authorised, or endpoint not deployed yet) doesn't
  // block the configs list from rendering.
  const flowsQuery = useQuery({
    queryKey: ['admin-merchant-flows'],
    queryFn: listMerchantFlows,
    retry: shouldRetry,
    staleTime: 30_000,
  });
  const flowsByMerchant = useMemo(() => {
    const map = new Map<string, MerchantFlow[]>();
    for (const f of flowsQuery.data?.flows ?? []) {
      let bucket = map.get(f.merchantId);
      if (bucket === undefined) {
        bucket = [];
        map.set(f.merchantId, bucket);
      }
      bucket.push(f);
    }
    return map;
  }, [flowsQuery.data]);

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

  const saveMutation = useMutation({
    mutationFn: async (args: { merchantId: string; draft: RowDraft; reason: string }) => {
      const wholesalePct = Number(args.draft.wholesalePct);
      const userCashbackPct = Number(args.draft.userCashbackPct);
      const loopMarginPct = Number(args.draft.loopMarginPct);
      return upsertCashbackConfig(args.merchantId, {
        wholesalePct,
        userCashbackPct,
        loopMarginPct,
        reason: args.reason,
      });
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
      wholesalePct: cfg?.wholesalePct ?? '0.00',
      userCashbackPct: cfg?.userCashbackPct ?? '0.00',
      loopMarginPct: cfg?.loopMarginPct ?? '0.00',
    };
  };

  const isDirty = (cfg: MerchantCashbackConfig | undefined, merchantId: string): boolean => {
    const d = drafts[merchantId];
    if (d === undefined) return false;
    return (
      d.wholesalePct !== (cfg?.wholesalePct ?? '0.00') ||
      d.userCashbackPct !== (cfg?.userCashbackPct ?? '0.00') ||
      d.loopMarginPct !== (cfg?.loopMarginPct ?? '0.00')
    );
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      <ReasonDialog
        open={reasonTarget !== null}
        title={
          reasonTarget !== null
            ? `Reason for updating ${reasonTarget.name}'s cashback split?`
            : 'Reason'
        }
        description="2–500 characters. Logged in the cashback-config audit trail (ADR-011)."
        confirmLabel="Save split"
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
            Three percentages per merchant. Must sum to at most the CTX discount for that merchant
            (100% cap enforced). Edits apply to new orders; in-flight orders keep their pinned
            split.
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
          <thead className="bg-gray-50 dark:bg-gray-900/40 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <tr>
              <th className="px-3 py-2">Merchant</th>
              <th className="px-3 py-2">Wholesale %</th>
              <th className="px-3 py-2">User cashback %</th>
              <th className="px-3 py-2">Loop margin %</th>
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
              const flows = flowsByMerchant.get(m.id) ?? [];
              return (
                <Fragment key={m.id}>
                  <tr className="border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900/30">
                    <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">
                      <div>{m.name}</div>
                      {flows.length > 0 ? (
                        <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] font-normal text-gray-500 dark:text-gray-400">
                          {flows.map((f) => (
                            <MerchantFlowSummary key={f.currency} flow={f} />
                          ))}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <PctInput
                        value={draft.wholesalePct}
                        onChange={(v) =>
                          setDrafts((d) => ({ ...d, [m.id]: { ...draft, wholesalePct: v } }))
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      <PctInput
                        value={draft.userCashbackPct}
                        onChange={(v) =>
                          setDrafts((d) => ({ ...d, [m.id]: { ...draft, userCashbackPct: v } }))
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      <PctInput
                        value={draft.loopMarginPct}
                        onChange={(v) =>
                          setDrafts((d) => ({ ...d, [m.id]: { ...draft, loopMarginPct: v } }))
                        }
                      />
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                      {cfg === undefined ? '—' : new Date(cfg.updatedAt).toLocaleDateString()}
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
              Fulfilled-order volume broken down by merchant, ranked by Loop margin (ADR 011/015).
              Tuning a merchant's split? Watch the margin column here for impact — small % changes
              on a high-volume merchant outweigh big tweaks on the long tail.
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

      {/* Per-merchant flywheel leaderboard (#602). Complement to the
          stats table above: that table answers "which merchants
          drive volume / cashback outlay / margin", this leaderboard
          answers "which merchants see recycled cashback (LOOP-asset
          paid orders)". The two together triangulate where the
          flywheel is taking hold. Self-hides on empty/error —
          first-order volume needs to land before the list is
          meaningful. */}
      <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <header className="flex flex-wrap items-start justify-between gap-3 px-6 py-4 border-b border-gray-200 dark:border-gray-800">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              Flywheel leaderboard
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Merchants ranked by recycled-cashback order volume in the last 31 days. Each row
              deep-links to the underlying order list.
            </p>
          </div>
          {/* Tier-3 CSV export (#613). Finance-grade snapshot of the
              ranking — matches the per-merchant stats CSV below
              section-wise, so ops can pair them in the same
              spreadsheet workbook. */}
          <CsvDownloadButton
            path="/api/admin/merchants/flywheel-share.csv"
            filename={`merchants-flywheel-share-${new Date().toISOString().slice(0, 10)}.csv`}
            label="Flywheel CSV"
          />
        </header>
        <div className="px-6 py-5">
          <MerchantsFlywheelShareCard />
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
      <td colSpan={6} className="px-3 py-3">
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

function HistoryTable({ rows }: { rows: MerchantCashbackConfigHistoryEntry[] }): React.JSX.Element {
  return (
    <table className="w-full text-xs">
      <thead className="text-left text-gray-500 dark:text-gray-400">
        <tr>
          <th className="pb-1 font-medium">Changed</th>
          <th className="pb-1 font-medium">By</th>
          <th className="pb-1 font-medium">Wholesale</th>
          <th className="pb-1 font-medium">User cashback</th>
          <th className="pb-1 font-medium">Loop margin</th>
          <th className="pb-1 font-medium">Active</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="text-gray-700 dark:text-gray-200">
            <td className="py-1 pr-2 whitespace-nowrap">
              {new Date(row.changedAt).toLocaleString()}
            </td>
            <td className="py-1 pr-2 font-mono text-[11px]">{row.changedBy}</td>
            <td className="py-1 pr-2">{row.wholesalePct}%</td>
            <td className="py-1 pr-2">{row.userCashbackPct}%</td>
            <td className="py-1 pr-2">{row.loopMarginPct}%</td>
            <td className="py-1 pr-2">{row.active ? 'Yes' : 'No'}</td>
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

/**
 * One-line summary of a (merchant, currency) flow bucket. Rendered
 * under the merchant name on /admin/cashback so ops can eyeball the
 * actual supplier split beside each merchant's configured split.
 * Hidden when the merchant has no fulfilled orders yet.
 */
function MerchantFlowSummary({ flow }: { flow: MerchantFlow }): React.JSX.Element {
  return (
    <span
      title={`${flow.count} fulfilled ${flow.currency} orders — face ${formatMinorCurrency(flow.faceValueMinor, flow.currency)}`}
    >
      {flow.count} {flow.currency} · CTX {formatMinorCurrency(flow.wholesaleMinor, flow.currency)} ·
      cashback {formatMinorCurrency(flow.userCashbackMinor, flow.currency)} · margin{' '}
      {formatMinorCurrency(flow.loopMarginMinor, flow.currency)}
    </span>
  );
}
