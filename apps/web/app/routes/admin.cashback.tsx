import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type { Route } from './+types/admin.cashback';
import { useAllMerchants } from '~/hooks/use-merchants';
import { useAuth } from '~/hooks/use-auth';
import {
  listCashbackConfigs,
  upsertCashbackConfig,
  type MerchantCashbackConfig,
} from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
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
export default function AdminCashbackRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const { merchants } = useAllMerchants();
  const queryClient = useQueryClient();

  const configsQuery = useQuery({
    queryKey: ['admin-cashback-configs'],
    queryFn: listCashbackConfigs,
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 0,
  });

  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  const configByMerchant = useMemo(() => {
    const map = new Map<string, MerchantCashbackConfig>();
    for (const c of configsQuery.data?.configs ?? []) map.set(c.merchantId, c);
    return map;
  }, [configsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async (args: { merchantId: string; draft: RowDraft }) => {
      const wholesalePct = Number(args.draft.wholesalePct);
      const userCashbackPct = Number(args.draft.userCashbackPct);
      const loopMarginPct = Number(args.draft.loopMarginPct);
      return upsertCashbackConfig(args.merchantId, {
        wholesalePct,
        userCashbackPct,
        loopMarginPct,
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

  if (!isAuthenticated) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-bold mb-4">Admin · Cashback</h1>
        <p className="text-gray-500 dark:text-gray-400 mb-4">Sign in to continue.</p>
        <Button onClick={() => void navigate('/auth')}>Sign in</Button>
      </div>
    );
  }

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
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">
        Cashback configuration
      </h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        Three percentages per merchant. Must sum to at most the CTX discount for that merchant (100%
        cap enforced). Edits apply to new orders; in-flight orders keep their pinned split.
      </p>

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
              return (
                <tr
                  key={m.id}
                  className="border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900/30"
                >
                  <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">{m.name}</td>
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
                  <td className="px-3 py-2">
                    <Button
                      variant="secondary"
                      disabled={!dirty || saving}
                      onClick={() => saveMutation.mutate({ merchantId: m.id, draft })}
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
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
