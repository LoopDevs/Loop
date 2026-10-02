import type { AppConfig } from '~/services/config';

const DEFAULT_CRYPTO_CURRENCIES = ['XLM'];

export function paymentOptionsFor(
  config: Pick<AppConfig, 'ctxPaymentCurrencies' | 'fiatPaymentCurrencies'>,
  cardCurrency: string,
): string[] {
  const crypto =
    config.ctxPaymentCurrencies.length > 0
      ? config.ctxPaymentCurrencies
      : DEFAULT_CRYPTO_CURRENCIES;
  const card = cardCurrency.toUpperCase();
  const fiat = (config.fiatPaymentCurrencies ?? []).filter((c) => c.toUpperCase() === card);
  return [...crypto, ...fiat];
}
