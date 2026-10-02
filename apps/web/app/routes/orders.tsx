import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Route } from './+types/orders';
import i18n from '~/i18n/i18next';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { useAuth } from '~/hooks/use-auth';
import { useAppConfig } from '~/hooks/use-app-config';
import { Navbar } from '~/components/features/Navbar';
import { PageHeader } from '~/components/ui/PageHeader';
import { Button } from '~/components/ui/Button';
import { LoopOrdersList } from '~/components/features/orders/LoopOrdersList';
import { OrdersSummaryHeader } from '~/components/features/orders/OrdersSummaryHeader';
import { CashbackEarningsHeadline } from '~/components/features/cashback/CashbackEarningsHeadline';

export function meta(): Route.MetaDescriptors {
  return [{ title: i18n.t('orders:list.meta.title') }];
}

export function ErrorBoundary(): React.JSX.Element {
  const { t } = useTranslation(['orders', 'common']);
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
          {t('common:errorBoundary.heading')}
        </h1>
        <a href="/orders" className="text-blue-600 underline">
          {t('orders:list.error.tryAgain')}
        </a>
      </div>
    </div>
  );
}

export default function OrdersRoute(): React.JSX.Element {
  const { t } = useTranslation('orders');
  const { isNative } = useNativePlatform();
  const { isAuthenticated } = useAuth();
  const { config } = useAppConfig();
  const navigate = useNavigate();

  return (
    <>
      {!isNative && <Navbar />}
      <PageHeader title={t('list.pageTitle')} fallbackHref="/" />

      {/* Native: NativeShell's `native-safe-page` already pads by
          `var(--safe-top)`, so we only need to clear the PageHeader
          row height (`h-14` = 3.5rem) — adding another safe-top here
          would double-count and push content ~50px too far down.
          Web: `pt-28` clears the fixed Navbar and matches the home
          hero / rates / settings top offset so page titles land at a
          consistent height. */}
      {/* `px-6` matches the /settings/* pages (same max-w-2xl container) so
          the content edge doesn't shift when navigating between them. */}
      <main className={`max-w-2xl mx-auto px-6 ${isNative ? 'pt-14 pb-4' : 'pt-28 pb-8'}`}>
        {/* Page title in the same style as /settings/cashback's
            "Cashback history" header. Web only — on native the
            PageHeader bar above already titles this screen, and a
            second in-page h1 would double it. */}
        {!isNative && (
          <header className="mb-6">
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
              {t('list.heading')}
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{t('list.subtitle')}</p>
          </header>
        )}
        {/* Lifetime cashback headline — silent no-op for zero-earnings
            users and for anyone who isn't signed in. Sits above the
            orders list so "earned with Loop" frames the content. */}
        {isAuthenticated ? (
          <div className="mb-4">
            <CashbackEarningsHeadline />
          </div>
        ) : null}

        {/* 5-number orders summary (ADR 010 / 015 / #584). Complement
            to the cashback headline above: cashback answers "what did
            I get", this answers "what did I buy". Self-hides for
            zero-activity users so new accounts aren't framed around
            empty numbers. */}
        {isAuthenticated ? (
          <div className="mb-4">
            <OrdersSummaryHeader />
          </div>
        ) : null}

        {isAuthenticated ? <LoopOrdersList enabled={config.loopOrdersEnabled} /> : null}

        {!isAuthenticated && (
          <div className="text-center py-12">
            <p className="text-gray-500 dark:text-gray-400 mb-4">{t('list.signedOut.body')}</p>
            <Button
              onClick={() => {
                void navigate('/auth');
              }}
            >
              {t('list.signedOut.cta')}
            </Button>
          </div>
        )}
      </main>
    </>
  );
}
