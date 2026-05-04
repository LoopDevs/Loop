import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import { applyBarcodeFields } from '../barcode-fields.js';

function makeLog(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: () => makeLog(),
  } as unknown as Logger;
}

describe('applyBarcodeFields', () => {
  it('extracts code/pin/imageUrl when CTX returns the canonical field names', () => {
    const order: Record<string, unknown> = {};
    applyBarcodeFields({
      upstream: { number: '4111-2222-3333', pin: '1234', barcodeUrl: 'https://x/bc.png' },
      orderId: 'o-1',
      order,
      log: makeLog(),
    });
    expect(order).toEqual({
      giftCardCode: '4111-2222-3333',
      giftCardPin: '1234',
      barcodeImageUrl: 'https://x/bc.png',
    });
  });

  it('falls back to alternate field names CTX has shipped historically', () => {
    const order: Record<string, unknown> = {};
    applyBarcodeFields({
      upstream: {
        cardNumber: 'ALT-CODE',
        cardPin: 'ALT-PIN',
        giftCardImageUrl: 'https://x/alt.png',
      },
      orderId: 'o-2',
      order,
      log: makeLog(),
    });
    expect(order).toEqual({
      giftCardCode: 'ALT-CODE',
      giftCardPin: 'ALT-PIN',
      barcodeImageUrl: 'https://x/alt.png',
    });
  });

  it('preferred field name wins over alternates when both are present', () => {
    // `number` is preferred over `cardNumber`/`code`/`giftCardCode`.
    const order: Record<string, unknown> = {};
    applyBarcodeFields({
      upstream: { number: 'PRIMARY', cardNumber: 'SECONDARY' },
      orderId: 'o-3',
      order,
      log: makeLog(),
    });
    expect(order.giftCardCode).toBe('PRIMARY');
  });

  it('skips fields that are missing or non-string', () => {
    const order: Record<string, unknown> = { existing: 'untouched' };
    applyBarcodeFields({
      upstream: { number: '', pin: 99, barcodeUrl: null },
      orderId: 'o-4',
      order,
      log: makeLog(),
    });
    expect(order).toEqual({ existing: 'untouched' });
  });

  it('logs the extraction outcome for ops visibility', () => {
    const log = makeLog();
    applyBarcodeFields({
      upstream: { number: 'CODE' },
      orderId: 'o-5',
      order: {},
      log,
    });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'o-5',
        extracted: expect.objectContaining({ hasCode: true, hasPin: false, hasImageUrl: false }),
      }),
      expect.any(String),
    );
  });

  it('does not overwrite existing order fields when upstream omits them', () => {
    const order: Record<string, unknown> = {
      giftCardCode: 'PRE-EXISTING',
      giftCardPin: 'PRE-PIN',
    };
    applyBarcodeFields({
      upstream: {},
      orderId: 'o-6',
      order,
      log: makeLog(),
    });
    expect(order).toEqual({ giftCardCode: 'PRE-EXISTING', giftCardPin: 'PRE-PIN' });
  });
});
