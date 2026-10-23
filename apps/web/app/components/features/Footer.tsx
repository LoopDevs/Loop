import { useTranslation } from 'react-i18next';
import { LocaleLink as Link } from '~/components/ui/LocaleLink';
import { LoopLogo } from '~/components/ui/LoopLogo';

export function Footer(): React.JSX.Element {
  const { t } = useTranslation('footer');
  const linkClass = 'text-ink-muted hover:text-ink transition-colors';
  return (
    <footer className="bg-surface-subtle border-t border-line mt-16">
      <div className="container mx-auto px-4 py-10">
        <div className="flex flex-col md:flex-row justify-between items-center gap-6">
          <Link to="/" className="flex items-center gap-3 text-ink">
            <LoopLogo className="h-6 w-auto" />
          </Link>
          <nav className="flex flex-wrap justify-center gap-x-6 gap-y-3 text-sm font-medium">
            <Link to="/" className={linkClass}>
              {t('directory')}
            </Link>
            <Link to="/map" className={linkClass}>
              {t('map')}
            </Link>
            <Link to="/cashback" className={linkClass}>
              {t('cashbackRates')}
            </Link>
            <Link to="/trustlines" className={linkClass}>
              {t('trustlines')}
            </Link>
            <Link to="/privacy" className={linkClass}>
              {t('privacy')}
            </Link>
            <Link to="/terms" className={linkClass}>
              {t('terms')}
            </Link>
          </nav>
          <p className="text-xs text-ink-subtle tabular">
            {t('copyright', { year: new Date().getFullYear() })}
          </p>
        </div>
      </div>
    </footer>
  );
}
