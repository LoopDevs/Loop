// @vitest-environment jsdom
/**
 * FE-41 regression: the wallet + cashback-history "money screens" must
 * export a route-level `ErrorBoundary` so an unhandled render/loader error
 * is caught AT THE ROUTE — rendered inside the parent layout's `<Outlet />`
 * (in the app that's `NativeShell`, which also mounts `NativeTabBar`) —
 * rather than bubbling to the root boundary, which replaces the whole `App`
 * and blanks the native app with no tab bar (unrecoverable white screen).
 *
 * The test mirrors that mount shape with a minimal parent "chrome" route
 * that renders a stand-in tab bar + `<Outlet />`, and the money route as its
 * child. A child render crash must:
 *   1. surface the route's recovery UI (heading + retry), not a blank crash;
 *   2. leave the parent chrome/tab-bar mounted (proving the boundary is
 *      route-scoped, below the chrome — not swallowing the whole layout).
 *
 * Proven red: with the route's `ErrorBoundary` export removed, the crash has
 * no route-level catch, bubbles past the (boundary-less) chrome route to
 * React Router's default root boundary, which unmounts the chrome — the
 * tab-bar assertion fails and the recovery heading is absent.
 */
import type { ComponentType } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, Outlet } from 'react-router';
import { ErrorBoundary as WalletErrorBoundary } from '../settings.wallet';
import { ErrorBoundary as CashbackErrorBoundary } from '../settings.cashback';

const TAB_BAR_TESTID = 'money-screen-chrome-tabbar';

/** Stand-in for `NativeShell`: renders persistent chrome + the route Outlet. */
function Chrome(): React.JSX.Element {
  return (
    <>
      <nav data-testid={TAB_BAR_TESTID} data-nav="tab">
        tab bar
      </nav>
      <Outlet />
    </>
  );
}

/** A route element that crashes on render — the FE-41 failure scenario. */
function Boom(): React.JSX.Element {
  throw new Error('simulated money-screen render crash');
}

function renderMoneyRoute(path: string, ErrorBoundary: ComponentType): void {
  const router = createMemoryRouter(
    [
      {
        element: <Chrome />,
        children: [{ path, element: <Boom />, ErrorBoundary }],
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
}

afterEach(cleanup);

describe.each([
  ['/settings/wallet', WalletErrorBoundary],
  ['/settings/cashback', CashbackErrorBoundary],
] as const)('FE-41 route-level ErrorBoundary on %s', (path, Boundary) => {
  it('catches a render crash, shows recovery UI, and keeps the chrome/tab-bar mounted', () => {
    renderMoneyRoute(path, Boundary);

    // Recovery UI is shown in place of a blank/whole-app crash.
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeTruthy();
    // A recoverable affordance (retry) is offered.
    expect(screen.getByRole('link', { name: /try again/i })).toBeTruthy();

    // Route-scoped: the parent chrome/tab-bar (mounted above the boundary,
    // i.e. NativeShell + NativeTabBar in the app) survives the child crash.
    expect(screen.getByTestId(TAB_BAR_TESTID)).toBeTruthy();
  });
});
