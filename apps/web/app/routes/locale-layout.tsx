import { Outlet, useParams } from 'react-router';
import { isSupportedCountryCode, isSupportedLang } from '@loop/shared';
import { NotFoundContent } from './not-found';

/**
 * ADR 034 locale layout (`/:country/:lang/*`) — the component-only variant used
 * by the mobile static export (SPA mode rejects `loader` exports). It validates
 * the locale segments client-side and renders the shared 404 UI for anything we
 * don't route; the SSR build uses `locale-layout-ssr.tsx`, whose loader throws a
 * real HTTP 404 so crawlers see the right status. Both render the same `Outlet`.
 *
 * Children read the active locale via `useLocale()` (URL is the source of
 * truth), so no context provider is needed here.
 */
export function LocaleLayout(): React.JSX.Element {
  const { country, lang } = useParams();
  if (!isSupportedCountryCode(country) || !isSupportedLang(lang)) {
    return <NotFoundContent />;
  }
  return <Outlet />;
}

export default LocaleLayout;
