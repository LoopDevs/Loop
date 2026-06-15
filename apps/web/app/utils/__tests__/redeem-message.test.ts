import { describe, it, expect } from 'vitest';
import { parseGiftCardMessage } from '../redeem-message';

describe('parseGiftCardMessage (CF-02 / WEB-S2)', () => {
  it('accepts a well-formed loop:giftcard message', () => {
    expect(parseGiftCardMessage({ type: 'loop:giftcard', code: 'ABC-123', pin: '4567' })).toEqual({
      code: 'ABC-123',
      pin: '4567',
    });
  });

  it('accepts code-only (no pin)', () => {
    expect(parseGiftCardMessage({ type: 'loop:giftcard', code: 'XYZ' })).toEqual({ code: 'XYZ' });
  });

  it('trims surrounding whitespace but keeps inner spaces', () => {
    expect(parseGiftCardMessage({ type: 'loop:giftcard', code: '  CO DE  ', pin: ' 99 ' })).toEqual(
      { code: 'CO DE', pin: '99' },
    );
  });

  it('drops a non-string / empty / control-char pin but keeps the code', () => {
    expect(parseGiftCardMessage({ type: 'loop:giftcard', code: 'C', pin: 123 })).toEqual({
      code: 'C',
    });
    expect(parseGiftCardMessage({ type: 'loop:giftcard', code: 'C', pin: '   ' })).toEqual({
      code: 'C',
    });
    expect(parseGiftCardMessage({ type: 'loop:giftcard', code: 'C', pin: 'a\tb' })).toEqual({
      code: 'C',
    });
  });

  it('rejects the wrong type / non-object / null', () => {
    expect(parseGiftCardMessage(null)).toBeNull();
    expect(parseGiftCardMessage('loop:giftcard')).toBeNull();
    expect(parseGiftCardMessage({ type: 'other', code: 'C' })).toBeNull();
    expect(parseGiftCardMessage({ code: 'C' })).toBeNull();
  });

  it('rejects a missing / empty / non-string code', () => {
    expect(parseGiftCardMessage({ type: 'loop:giftcard' })).toBeNull();
    expect(parseGiftCardMessage({ type: 'loop:giftcard', code: '' })).toBeNull();
    expect(parseGiftCardMessage({ type: 'loop:giftcard', code: '   ' })).toBeNull();
    expect(parseGiftCardMessage({ type: 'loop:giftcard', code: 42 })).toBeNull();
  });

  it('rejects an oversized code (forged blob)', () => {
    expect(parseGiftCardMessage({ type: 'loop:giftcard', code: 'x'.repeat(257) })).toBeNull();
  });

  it('rejects a code containing control characters', () => {
    expect(parseGiftCardMessage({ type: 'loop:giftcard', code: 'AB\x01CD' })).toBeNull();
    expect(parseGiftCardMessage({ type: 'loop:giftcard', code: 'AB\nCD' })).toBeNull();
    expect(parseGiftCardMessage({ type: 'loop:giftcard', code: 'AB\x00CD' })).toBeNull();
  });
});
