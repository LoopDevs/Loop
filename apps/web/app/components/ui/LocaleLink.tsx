import { Link, type LinkProps } from 'react-router';
import { isLocalizablePath, localizedHref, useActiveLocale } from '~/i18n/locale';

/**
 * A drop-in for React Router's `<Link>` that keeps the visitor in their locale
 * (ADR 034 Phase 3). When the current route is localized (`/:country/:lang/...`)
 * and the destination has a localized mount, the `to` is prefixed with the
 * active locale — so a click from `/gb/en` stays on `/gb/en/...`.
 *
 * It is a deliberate **no-op** when the current route carries no locale (an
 * app/admin route) or the target isn't localizable (`/orders`, `/admin/…`): the
 * link passes through unchanged, so it never invents a locale the visitor didn't
 * pick (the `/` geo-redirect + saved cookie restore their country instead).
 *
 * Public-surface components import this aliased as `Link` so the JSX is
 * untouched: `import { LocaleLink as Link } from '~/components/ui/LocaleLink'`.
 */
export function LocaleLink({ to, ...rest }: LinkProps): React.JSX.Element {
  const locale = useActiveLocale();
  const next =
    locale && typeof to === 'string' && isLocalizablePath(to) ? localizedHref(to, locale) : to;
  return <Link to={next} {...rest} />;
}
