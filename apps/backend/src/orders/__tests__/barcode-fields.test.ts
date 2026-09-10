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

  it('ignores field names CTX does not return', () => {
    // No fallback list — a CTX rename must fail loudly in the ops log rather than be silently absorbed.
    const order: Record<string, unknown> = {};
    applyBarcodeFields({
      upstream: {
        cardNumber: 'ALT-CODE',
        giftCardCode: 'ALT-CODE-2',
        cardPin: 'ALT-PIN',
        giftCardImageUrl: 'https://x/alt.png',
      },
      orderId: 'o-2',
      order,
      log: makeLog(),
    });
    expect(order).toEqual({});
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
