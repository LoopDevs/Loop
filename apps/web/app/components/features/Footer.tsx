import { LocaleLink as Link } from '~/components/ui/LocaleLink';
import { useAppConfig } from '~/hooks/use-app-config';
import { LoopLogo } from '~/components/ui/LoopLogo';

export function Footer(): React.JSX.Element {
  const { config } = useAppConfig();
  // Tranche 1 (MVP): hide the cashback / trustlines footer links
  // until Tranche 2 turns on the Stellar wallet.
  const showCashback = !config.phase1Only;
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
              Directory
            </Link>
            <Link to="/map" className={linkClass}>
              Map
            </Link>
            {showCashback && (
              <>
                <Link to="/cashback" className={linkClass}>
                  Cashback rates
                </Link>
                <Link to="/trustlines" className={linkClass}>
                  Trustlines
                </Link>
              </>
            )}
            <Link to="/privacy" className={linkClass}>
              Privacy
            </Link>
            <Link to="/terms" className={linkClass}>
              Terms
            </Link>
          </nav>
          <p className="text-xs text-ink-subtle tabular">
            &copy; {new Date().getFullYear()} Loop. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
