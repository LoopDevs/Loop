import { useQuery } from '@tanstack/react-query';
import { getAdminDiscordNotifiers, type AdminDiscordNotifier } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

/**
 * Per-channel pill colour. Distinct from the payout-state pill on
 * the treasury — these are informational, not actionable, so the
 * palette leans soft. Used by both the badge rendering and the
 * group-heading accent when we grow multi-tier.
 */
const CHANNEL_CLASSES: Record<AdminDiscordNotifier['channel'], string> = {
  orders: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  monitoring: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  'admin-audit': 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
};

/**
 * Admin surface: the backend's Discord notifier catalog (ADR 018 /
 * #572). Rendered on `/admin/treasury` as an ops-visibility card —
 * "what signals will this system page us with?". The list is
 * sourced from `DISCORD_NOTIFIERS` in `apps/backend/src/discord.ts`
 * which is Object.frozen and catalog-invariant-tested against every
 * `notify*` export, so this card is always in lockstep with the
 * code.
 *
 * Self-hides on pending / error so the card doesn't flash on cold
 * load and doesn't leave a dangling header over a spinner if the
 * static read ever fails. Staleness is generous (1h) because the
 * catalog only changes when a notifier-adding PR lands.
 */
export function DiscordNotifiersCard(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-discord-notifiers'],
    queryFn: getAdminDiscordNotifiers,
    retry: shouldRetry,
    staleTime: 60 * 60 * 1000,
  });

  if (query.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  if (query.isError) {
    return (
      <p className="py-4 text-sm text-red-600 dark:text-red-400">
        Failed to load Discord notifier catalog.
      </p>
    );
  }

  const notifiers = query.data.notifiers;
  if (notifiers.length === 0) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        No Discord notifiers configured.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900/50">
          <tr>
            {['Notifier', 'Channel', 'Fires when'].map((h) => (
              <th
                key={h}
                className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-900 bg-white dark:bg-gray-900">
          {notifiers.map((n) => (
            <tr key={n.name}>
              <td className="px-3 py-2 font-mono text-xs text-gray-900 dark:text-white whitespace-nowrap">
                {n.name}
              </td>
              <td className="px-3 py-2">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${CHANNEL_CLASSES[n.channel]}`}
                >
                  {n.channel}
                </span>
              </td>
              <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{n.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
