import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ApiException, isHomeCurrency } from '@loop/shared';
import type { Route } from './+types/admin.users.$userId';
import { shouldRetry } from '~/hooks/query-retry';
import { getAdminUser, getAdminUserCredits, type AdminUserCreditRow } from '~/services/admin';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { AdminLookupSearch } from '~/components/features/admin/AdminLookupSearch';
import { RequireStaff } from '~/components/features/admin/RequireAdmin';
import { RevokeSessionsPanel } from '~/components/features/admin/RevokeSessionsPanel';
import { AdminUserFlywheelChip } from '~/components/features/admin/AdminUserFlywheelChip';
import { CashbackSummaryChip } from '~/components/features/admin/CashbackSummaryChip';
import { CopyButton } from '~/components/features/admin/CopyButton';
import { CreditAdjustmentForm } from '~/components/features/admin/CreditAdjustmentForm';
import { AdminEmissionForm } from '~/components/features/admin/AdminEmissionForm';
import { HomeCurrencyForm } from '~/components/features/admin/HomeCurrencyForm';
import { CreditTransactionsTable } from '~/components/features/admin/CreditTransactionsTable';
import { CsvDownloadButton } from '~/components/features/admin/CsvDownloadButton';
import { UserCashbackByMerchantTable } from '~/components/features/admin/UserCashbackByMerchantTable';
import { UserCashbackMonthlyChart } from '~/components/features/admin/UserCashbackMonthlyChart';
import { UserOperatorMixCard } from '~/components/features/admin/UserOperatorMixCard';
import { UserOrdersTable } from '~/components/features/admin/UserOrdersTable';
import { UserRailMixCard } from '~/components/features/admin/UserRailMixCard';
import { UserPayoutsTable } from '~/components/features/admin/UserPayoutsTable';
import { UserAuditTimeline } from '~/components/features/admin/UserAuditTimeline';
import { UserWalletCard } from '~/components/features/admin/UserWalletCard';
import { Spinner } from '~/components/ui/Spinner';
import { useStaffRole } from '~/hooks/use-staff-role';
import { ADMIN_LOCALE } from '~/utils/locale';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · User — Loop' }];
}

// A2-1520: local fmtMinor replaced with bigint-safe shared helper.
import { formatMinorCurrency as fmtMinor } from '@loop/shared';

/**
 * `/admin/users/:userId` — user detail + credit-balance drill.
 *
 * Two parallel queries: the user row itself (for the header card)
 * and the per-currency credit balances (for the balance table).
 * TanStack caches both — a drill from /admin/users reuses the list
 * page's cache miss isn't retraversed.
 *
 * The credit-adjustment form + the credit-transactions log are
 * follow-up slices (ADR 017 backend is already live).
 *
 * ADR 037 — this is the "User 360" surface. Support-visible
 * (minimum="support"): the profile / credits / wallet / orders /
 * payouts / ledger reads plus the wallet re-trigger action. The
 * money-write forms (credit adjustment, emission, home-currency
 * change) and the CSV mass export render ONLY for the admin role —
 * hidden, not disabled, so support never sees surfaces it can't use.
 */
// A2-1101: see RequireAdmin.tsx for the shell-gate rationale.
export default function AdminUserDetailRoute(): React.JSX.Element {
  return (
    <RequireStaff minimum="support">
      <AdminUserDetailRouteInner />
    </RequireStaff>
  );
}

function AdminUserDetailRouteInner(): React.JSX.Element {
  const { userId } = useParams<{ userId: string }>();
  // ADR 037: admin-only sections key off the resolved role.
  const { isAdminRole } = useStaffRole();

  const userQuery = useQuery({
    queryKey: ['admin-user', userId ?? null],
    queryFn: () => getAdminUser(userId ?? ''),
    enabled: userId !== undefined && userId.length > 0,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  const creditsQuery = useQuery({
    queryKey: ['admin-user-credits', userId ?? null],
    queryFn: () => getAdminUserCredits(userId ?? ''),
    enabled: userId !== undefined && userId.length > 0,
    retry: shouldRetry,
    staleTime: 15_000,
  });

  // 404 body is used by both the user fetch (user not found) and the
  // credits fetch (shouldn't happen if the user exists, but handle
  // defensively — surface the same copy either way).
  const userNotFound = userQuery.error instanceof ApiException && userQuery.error.status === 404;

  return (
    <main className="max-w-4xl mx-auto px-6 py-12 space-y-6">
      <AdminNav />
      <nav aria-label="Back to user list">
        <Link
          to="/admin/users"
          className="text-sm text-gray-600 hover:underline dark:text-gray-400"
        >
          ← All users
        </Link>
      </nav>

      {/* ADR 037: global reverse lookup — email / order id / payment
          memo / Stellar address. Lives on the 360 page because this
          is where a support ticket usually starts. */}
      <AdminLookupSearch />

      {userQuery.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : userNotFound ? (
        <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">User not found</h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            No user with id <code className="font-mono text-xs">{userId}</code>. The row may have
            been deleted, or the link is wrong.
          </p>
        </section>
      ) : userQuery.isError ? (
        <p className="text-red-600 dark:text-red-400 py-6">
          Failed to load user. You may not be an admin.
        </p>
      ) : (
        <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
          <header className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
                {userQuery.data.email}
              </h1>
              <p className="mt-1 text-xs font-mono text-gray-500 dark:text-gray-400 inline-flex items-center gap-1">
                {userQuery.data.id}
                <CopyButton text={userQuery.data.id} label="Copy user id" />
              </p>
            </div>
            {userQuery.data.isAdmin ? (
              <span className="rounded-full bg-purple-100 px-2.5 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
                admin
              </span>
            ) : null}
          </header>
          {/* Scalar cashback headline — self-hides for zero-earnings
              users so brand-new accounts aren't framed around an empty
              "£0 lifetime" pill. Renders in the user-detail block so
              operators see it adjacent to the identity / home-currency
              facts rather than buried next to the credits table. */}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <CashbackSummaryChip userId={userQuery.data.id} />
            {/* Flywheel chip — recycled-vs-total counts. Unlike the
                cashback chip it renders even for zero-recycled users
                (as a muted line) so an operator can tell "nothing
                yet" apart from "the chip crashed". */}
            <AdminUserFlywheelChip userId={userQuery.data.id} />
          </div>
          <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 text-sm">
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Home currency</dt>
              <dd className="text-gray-900 dark:text-white">{userQuery.data.homeCurrency}</dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Stellar address</dt>
              <dd className="text-gray-900 dark:text-white font-mono text-xs break-all">
                {userQuery.data.stellarAddress ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">CTX user id</dt>
              <dd className="text-gray-900 dark:text-white font-mono text-xs break-all">
                {userQuery.data.ctxUserId ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Signed up</dt>
              <dd className="text-gray-900 dark:text-white">
                {new Date(userQuery.data.createdAt).toLocaleString(ADMIN_LOCALE, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </dd>
            </div>
          </dl>
        </section>
      )}

      {/* A5-2: incident-response session revocation. Admin-tier
          (unlike the wallet re-trigger above, this isn't a
          support-allowed delivery-unsticking action), so it renders
          right after the identity card alongside the other
          admin-only writes below — self-hides via RevokeSessionsPanel's
          own isAdminRole check. */}
      {isAdminRole && userQuery.data !== undefined && !userNotFound && userId !== undefined ? (
        <RevokeSessionsPanel userId={userId} userEmail={userQuery.data.email} />
      ) : null}

      <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Credit balances</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Off-chain ledger balances per currency (ADR 009 / 015). Adjustments are applied via the
            form below and land as signed <code className="font-mono">credit_transactions</code>{' '}
            rows.
          </p>
        </header>
        {creditsQuery.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : creditsQuery.isError ? (
          <p className="px-6 py-6 text-sm text-red-600 dark:text-red-400">
            Failed to load credit balances.
          </p>
        ) : creditsQuery.data.rows.length === 0 ? (
          <p className="px-6 py-6 text-sm text-gray-500 dark:text-gray-400">
            No credit balances for this user yet.
          </p>
        ) : (
          <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-800">
            <thead>
              <tr>
                {['Currency', 'Balance', 'Last updated'].map((h) => (
                  <th
                    key={h}
                    className="px-6 py-2 text-left font-medium text-gray-500 dark:text-gray-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-900">
              {creditsQuery.data.rows.map((c: AdminUserCreditRow) => (
                <tr key={c.currency}>
                  <td className="px-6 py-3 font-medium text-gray-900 dark:text-white">
                    {c.currency}
                  </td>
                  <td className="px-6 py-3 tabular-nums text-gray-900 dark:text-white">
                    {fmtMinor(c.balanceMinor, c.currency)}
                  </td>
                  <td className="px-6 py-3 whitespace-nowrap text-gray-600 dark:text-gray-400">
                    {new Date(c.updatedAt).toLocaleString(ADMIN_LOCALE, {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ADR 037 / ADR 030 Phase C: wallet provisioning card with the
          support-allowed re-trigger action. Renders for both staff
          roles — unsticking delivery is support's job. */}
      {userId !== undefined && !userNotFound ? <UserWalletCard userId={userId} /> : null}

      {isAdminRole && userQuery.data !== undefined && !userNotFound && userId !== undefined ? (
        <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              Apply adjustment (ADR 017)
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Positive amount credits the user; negative amount debits. A debit that would drive the
              balance below zero returns <code className="font-mono">409</code> —
              InsufficientBalanceError. Every submission is idempotent on the browser-generated key
              and fires a Discord audit after commit.
            </p>
          </header>
          <div className="px-6 py-5">
            <CreditAdjustmentForm
              userId={userId}
              defaultCurrency={
                isHomeCurrency(userQuery.data.homeCurrency) ? userQuery.data.homeCurrency : 'USD'
              }
            />
          </div>
        </section>
      ) : null}

      {isAdminRole && userQuery.data !== undefined && !userNotFound && userId !== undefined ? (
        <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              Queue emission (ADR 024 / ADR 036)
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Queues an on-chain LOOP-asset payout backfilling the on-chain half of an existing
              liability — the off-chain mirror is <em>not</em> debited (ADR 036). An amount above
              the mirror balance returns <code className="font-mono">400</code>; one above the
              <em> un-emitted</em> portion (prior payouts/emissions already materialised it) is
              <code className="font-mono">409</code> EMISSION_EXCEEDS_UNEMITTED_BALANCE with the
              remaining headroom in the message; a duplicate active intent surfaces as
              <code className="font-mono">409</code> EMISSION_ALREADY_ISSUED; the fleet-wide daily
              cap returns <code className="font-mono">429</code>. Idempotent on the
              browser-generated key + Discord-audited after commit.
            </p>
          </header>
          <div className="px-6 py-5">
            <AdminEmissionForm
              userId={userId}
              defaultCurrency={
                isHomeCurrency(userQuery.data.homeCurrency) ? userQuery.data.homeCurrency : 'USD'
              }
            />
          </div>
        </section>
      ) : null}

      {isAdminRole && userQuery.data !== undefined && !userNotFound && userId !== undefined ? (
        <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              Change home currency (ADR 015)
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Support-mediated only. The backend rejects the change with{' '}
              <code className="font-mono">409</code> if the user has a non-zero credit balance in
              the current currency or any in-flight payouts — zero those out via a credit-adjustment
              and let pending payouts settle first. Idempotent + Discord-audited like every other
              admin write.
            </p>
          </header>
          <div className="px-6 py-5">
            <HomeCurrencyForm
              userId={userId}
              currentHomeCurrency={
                isHomeCurrency(userQuery.data.homeCurrency) ? userQuery.data.homeCurrency : 'USD'
              }
            />
          </div>
        </section>
      ) : null}

      {userId !== undefined && !userNotFound ? (
        <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">Recent orders</h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              The user&rsquo;s last 25 Loop-native orders (ADR 011/015). Click an id for the full
              state + cashback-split + timeline drill-down.
            </p>
          </header>
          <div className="px-6 py-5">
            <UserOrdersTable userId={userId} />
          </div>
        </section>
      ) : null}

      {/* Rail mix (#629) — per-user payment-method share.
          Summary view of the orders table above; a rising LOOP-asset
          share means this user is recycling cashback rather than
          topping up fresh XLM. Drill links filter the admin orders
          list to this user + rail + fulfilled. */}
      {userId !== undefined && !userNotFound ? <UserRailMixCard userId={userId} /> : null}

      {userId !== undefined && !userNotFound ? (
        <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              Recent on-chain payouts
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Stellar cashback emissions for this user (ADR 015/016). Each row links to the payout
              detail for tx hash + Stellar Expert + retry controls.
            </p>
          </header>
          <div className="px-6 py-5">
            <UserPayoutsTable userId={userId} />
          </div>
        </section>
      ) : null}

      {/* Operator mix (ADR 013 / 022) — which CTX operators have
          carried this user's recent orders. Support-triage pivot:
          if their cashback is slow, this card correlates it with
          a specific operator's health (a failing operator name
          here links straight to the per-operator drill). Slot
          below on-chain payouts so the flow reads "ledger →
          on-chain settlement → supplier attribution". */}
      {userId !== undefined && !userNotFound ? (
        <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              Operator mix (24h)
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Which CTX operators have carried this user&apos;s orders. Drill into an operator to
              check its health; the failed-count cell opens the per-(user, operator) failed orders
              list.
            </p>
          </header>
          <div className="px-6 py-5">
            <UserOperatorMixCard userId={userId} />
          </div>
        </section>
      ) : null}

      {/* Monthly cashback trend (#633) — 12-month time-series of
          the user's cashback emissions. Answers "is this user
          earning more cashback month-over-month?". Reuses the
          fleet `AdminMonthlyCashbackChart` visual primitives for
          identical bar rendering; entries are user-scoped via the
          admin cashback-monthly endpoint. */}
      {userId !== undefined && !userNotFound ? (
        <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              Monthly cashback (last 12 months)
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Cashback emitted to this user per calendar month, per currency (ADR 009/015). The
              time-series companion to the cashback-summary chip above — same data, different axis.
            </p>
          </header>
          <div className="px-6 py-5">
            <UserCashbackMonthlyChart userId={userId} />
          </div>
        </section>
      ) : null}

      {userId !== undefined && !userNotFound ? (
        <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              Cashback by merchant
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Which merchants this user has earned cashback from in the last 180 days (ADR 009/015).
              Support triage: answers &ldquo;why haven&rsquo;t I earned on merchant X?&rdquo; with
              the authoritative ledger view. Clicking a merchant deep-links to the orders list
              scoped to that user + merchant.
            </p>
          </header>
          <div className="px-6 py-5">
            <UserCashbackByMerchantTable userId={userId} />
          </div>
        </section>
      ) : null}

      {userId !== undefined && !userNotFound ? (
        <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <header className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4 dark:border-gray-800">
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">
                Credit transactions
              </h2>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Append-only ledger (ADR 009). Filter by type; page with the buttons below. Use the
                CSV download for a compliance / subject-access export of the last 366 days.
              </p>
            </div>
            <div className="flex items-center gap-3">
              {/* ADR 018 drill-down: the fleet-wide browser (A5-8) is
                  the natural "zoom out from this user" companion to
                  this per-user view. */}
              <Link
                to={`/admin/ledger?userId=${encodeURIComponent(userId)}`}
                className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                View in fleet-wide ledger →
              </Link>
              {/* ADR 037 §3: CSV mass exports are admin-only (PII-mass
                  surface) — hidden for support, not disabled. */}
              {isAdminRole ? (
                <CsvDownloadButton
                  path={`/api/admin/users/${encodeURIComponent(userId)}/credit-transactions.csv`}
                  filename={`credit-transactions-${userId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.csv`}
                />
              ) : null}
            </div>
          </header>
          <div className="px-6 py-5">
            <CreditTransactionsTable userId={userId} />
          </div>
        </section>
      ) : null}

      {/* A5-7: per-subject audit timeline — the consolidated "what
          happened to this account" view (admin actions targeting
          this user + ledger + orders + payouts + session
          revocations, merged newest-first). Sits last on the page:
          every section above is one axis of this view's source
          material, so it reads as the summary once you've already
          seen the individual tables. */}
      {userId !== undefined && !userNotFound ? (
        <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              Audit timeline
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Merged, newest-first view of admin actions on this account, money movements, order and
              payout state changes, and session revocations (ADR 037 / A5-7). Read-only; each row
              drill-links to its own detail page. Admin actions older than 24h are no longer
              retrievable (the write-audit store is a TTL cache, not a durable log) and the OTP-lock
              row reflects current state only, not history.
            </p>
          </header>
          <div className="px-6 py-5">
            <UserAuditTimeline userId={userId} />
          </div>
        </section>
      ) : null}
    </main>
  );
}
