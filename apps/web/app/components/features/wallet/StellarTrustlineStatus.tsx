import { useQuery } from '@tanstack/react-query';
import { getUserStellarTrustlines } from '~/services/user';
import { shouldRetry } from '~/hooks/query-retry';

/**
 * `/settings/wallet` — live per-LOOP-asset trustline status. Complements
 * `TrustlineSetupCard` which shows the canonical (code, issuer) pairs
 * a user needs to open a trustline against; this card answers the
 * follow-up: "did my wallet actually open it?".
 *
 * Catches the #1 cashback footgun at source — without an established
 * trustline the payout worker submits, Horizon rejects with
 * `op_no_trust`, and the user's cashback lands as a `failed`
 * pending_payouts row they don't understand.
 *
 * States:
 *   - `accountLinked: false`  → self-hides (the address form is the
 *     primary surface in that case).
 *   - `accountExists: false`  → amber banner: "fund your wallet with
 *     XLM reserve before any trustline can be created".
 *   - Any row `present: false` → amber banner listing the missing
 *     codes, deep-linking to the setup card with issuer details.
 *   - All present → muted green "wallet ready to receive cashback".
 *
 * Shares the `['me', 'stellar-trustlines']` query key so any other
 * surface that adopts this signal will dedupe the fetch.
 */
export function StellarTrustlineStatus(): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['me', 'stellar-trustlines'],
    queryFn: getUserStellarTrustlines,
    retry: shouldRetry,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  if (query.isPending || query.isError) return null;
  const data = query.data;
  if (!data.accountLinked) return null;

  const missing = data.rows.filter((r) => !r.present);

  if (!data.accountExists) {
    return (
      <section
        role="status"
        aria-label="Wallet not funded"
        className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900/60 dark:bg-amber-900/20"
      >
        <div className="font-medium text-amber-900 dark:text-amber-100">Wallet not funded</div>
        <p className="mt-0.5 text-amber-800 dark:text-amber-200">
          Send a small XLM reserve to your linked address before opening trustlines. Stellar
          accounts need a minimum balance to exist on the network.
        </p>
      </section>
    );
  }

  if (missing.length > 0) {
    return (
      <section
        role="status"
        aria-label="Missing trustlines"
        className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900/60 dark:bg-amber-900/20"
      >
        <div className="font-medium text-amber-900 dark:text-amber-100">
          {missing.length === 1 ? 'Missing trustline' : 'Missing trustlines'}:{' '}
          <span className="font-mono">{missing.map((r) => r.code).join(', ')}</span>
        </div>
        <p className="mt-0.5 text-amber-800 dark:text-amber-200">
          Your next cashback payout in {missing.length === 1 ? 'this asset' : 'these assets'} will
          fail until you open a trustline to the verified issuer below.
        </p>
      </section>
    );
  }

  return (
    <section
      role="status"
      aria-label="Wallet ready"
      className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm dark:border-green-900/60 dark:bg-green-900/20"
    >
      <div className="font-medium text-green-900 dark:text-green-100">
        Wallet ready to receive cashback
      </div>
      <p className="mt-0.5 text-green-800 dark:text-green-200">
        All LOOP-asset trustlines are established on your linked address.
      </p>
    </section>
  );
}
