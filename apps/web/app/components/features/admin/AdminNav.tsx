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
 * Deliberately no auth gate inside the component — each admin page
 * already gates on `requireAdmin` at the backend and renders a
 * "Not authorised" body on 401/404. The nav itself is safe to render
 * for any caller; non-admins just can't follow the links usefully.
 */
import { Link, useLocation } from 'react-router';

const TABS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/admin/cashback', label: 'Cashback' },
  { href: '/admin/treasury', label: 'Treasury' },
  { href: '/admin/payouts', label: 'Payouts' },
];

export function AdminNav(): React.JSX.Element {
  const { pathname } = useLocation();
  return (
    <nav
      aria-label="Admin sections"
      className="mb-6 flex items-center gap-1 border-b border-gray-200 dark:border-gray-800"
    >
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
    </nav>
  );
}
