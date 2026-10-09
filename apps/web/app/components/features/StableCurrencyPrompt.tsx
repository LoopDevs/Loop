import { useRef } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  countryByCode,
  displayCurrencyCode,
  heldStableForCurrency,
  type UserMeView,
} from '@loop/shared';
import { Button } from '~/components/ui/Button';
import { Dialog } from '~/components/ui/Dialog';
import { shouldRetry } from '~/hooks/query-retry';
import { getMe } from '~/services/user';
import { useAuthStore } from '~/stores/auth.store';

export function StableCurrencyPrompt(): React.JSX.Element {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const pending = useAuthStore((s) => s.stableCurrencyPromptPending);
  const setPending = useAuthStore((s) => s.setStableCurrencyPromptPending);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const me = useQuery<UserMeView, Error>({
    queryKey: ['me'],
    queryFn: getMe,
    enabled: pending,
    retry: shouldRetry,
    staleTime: 60_000,
  });

  const open = pending && me.data !== undefined;
  const confirm = (): void => setPending(false);
  const changeInSettings = (): void => {
    setPending(false);
    void navigate('/settings/wallet');
  };

  const country = me.data?.country ? countryByCode(me.data.country) : undefined;
  const homeCurrency = me.data?.homeCurrency ?? 'USD';
  const stable = displayCurrencyCode(heldStableForCurrency(homeCurrency));

  return (
    <Dialog
      open={open}
      onClose={confirm}
      initialFocusRef={confirmRef}
      labelledBy="stable-currency-prompt-heading"
      describedBy="stable-currency-prompt-body"
    >
      <div className="flex flex-col gap-3 p-5">
        <h2 id="stable-currency-prompt-heading" className="text-base font-semibold">
          {t('stableCurrencyPrompt.heading')}
        </h2>
        <div
          id="stable-currency-prompt-body"
          className="text-sm text-gray-700 dark:text-gray-300 space-y-3"
        >
          {open ? (
            <>
              <p>
                {country !== undefined
                  ? t('stableCurrencyPrompt.bodyWithCountry', {
                      country: `${country.flag} ${country.label}`,
                      stable,
                      currency: homeCurrency,
                    })
                  : t('stableCurrencyPrompt.body', { stable, currency: homeCurrency })}
              </p>
              <p>{t('stableCurrencyPrompt.actions')}</p>
            </>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={changeInSettings}>
            {t('stableCurrencyPrompt.settings')}
          </Button>
          <Button ref={confirmRef} onClick={confirm}>
            {t('stableCurrencyPrompt.confirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
