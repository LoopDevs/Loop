import { describe, it, expect } from 'vitest';
import { paymentOptionsFor } from '../payment-options';

describe('paymentOptionsFor', () => {
  it('offers every operator crypto currency plus the fiat currency matching the card', () => {
    const options = paymentOptionsFor(
      { ctxPaymentCurrencies: ['XLM', 'DASH'], fiatPaymentCurrencies: ['USD', 'GBP', 'EUR'] },
      'gbp',
    );
    expect(options).toEqual(['XLM', 'DASH', 'GBP']);
  });

  it('offers no fiat option when the operator cannot take the card currency', () => {
    const options = paymentOptionsFor(
      { ctxPaymentCurrencies: ['XLM'], fiatPaymentCurrencies: ['USD', 'EUR'] },
      'GBP',
    );
    expect(options).toEqual(['XLM']);
  });

  it('falls back to XLM when the config carries no crypto currencies', () => {
    expect(
      paymentOptionsFor({ ctxPaymentCurrencies: [], fiatPaymentCurrencies: [] }, 'USD'),
    ).toEqual(['XLM']);
  });
});
