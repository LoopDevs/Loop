import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { countryByCode } from '@loop/shared';
import { useHomeCountry } from '~/hooks/use-home-country';
import { Dialog } from '~/components/ui/Dialog';
import { localizedHref, useLocale } from '~/i18n/locale';

interface OutsideHomeCountryDialogProps {
  merchantId: string;
  merchantCountry: string | undefined;
}

export function OutsideHomeCountryDialog({
  merchantId,
  merchantCountry,
}: OutsideHomeCountryDialogProps): React.JSX.Element {
  const { t } = useTranslation('giftCard');
  const navigate = useNavigate();
  const { lang } = useLocale();
  const homeCountry = useHomeCountry();
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const continueRef = useRef<HTMLButtonElement | null>(null);

  const outsideHome =
    homeCountry !== null &&
    merchantCountry !== undefined &&
    merchantCountry.toLowerCase() !== homeCountry;
  const dismissalKey = `${merchantId}:${homeCountry ?? ''}`;
  const open = outsideHome && dismissedFor !== dismissalKey;

  const countryLabel = (code: string): string => countryByCode(code)?.label ?? code.toUpperCase();
  const countryName = (code: string): string => {
    const country = countryByCode(code);
    return country === undefined ? code.toUpperCase() : `${country.flag} ${country.label}`;
  };

  const dismiss = (): void => setDismissedFor(dismissalKey);
  const goHome = (): void => {
    if (homeCountry === null) return;
    void navigate(localizedHref('/', { country: homeCountry, lang }));
  };

  return (
    <Dialog
      open={open}
      onClose={dismiss}
      labelledBy="outside-home-country-heading"
      describedBy="outside-home-country-body"
      initialFocusRef={continueRef}
    >
      <div className="p-6">
        <h2 id="outside-home-country-heading" className="text-lg font-semibold mb-3">
          {t('outsideHomeCountry.heading')}
        </h2>
        <div
          id="outside-home-country-body"
          className="text-sm text-gray-600 dark:text-gray-300 mb-6 space-y-3"
        >
          {open ? (
            <>
              <p>
                {t('outsideHomeCountry.body', {
                  merchantCountry: countryName(merchantCountry),
                  homeCountry: countryName(homeCountry),
                  merchantCountryName: countryLabel(merchantCountry),
                })}
              </p>
              <p>{t('outsideHomeCountry.actions')}</p>
            </>
          ) : null}
        </div>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={goHome}
            className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            {t('outsideHomeCountry.home')}
          </button>
          <button
            ref={continueRef}
            type="button"
            onClick={dismiss}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
          >
            {t('outsideHomeCountry.continue')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
