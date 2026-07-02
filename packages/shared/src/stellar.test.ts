import { describe, expect, it } from 'vitest';

import { STELLAR_PUBKEY_REGEX } from './stellar.js';

// Structurally valid ED25519 account id: G + 55 base32 chars.
const VALID_G = 'G' + 'A'.repeat(55);

describe('STELLAR_PUBKEY_REGEX', () => {
  it('accepts a well-formed G... account id', () => {
    expect(STELLAR_PUBKEY_REGEX.test(VALID_G)).toBe(true);
    expect(STELLAR_PUBKEY_REGEX.test('G' + 'B7'.repeat(27) + 'C')).toBe(true);
  });

  it('rejects muxed accounts (M...) by design', () => {
    // Loop rejects muxed on purpose — memo-based attribution would
    // collide with muxed subaccount resolution.
    expect(STELLAR_PUBKEY_REGEX.test('M' + 'A'.repeat(55))).toBe(false);
    expect(STELLAR_PUBKEY_REGEX.test('M' + 'A'.repeat(68))).toBe(false);
  });

  it('rejects wrong lengths', () => {
    expect(STELLAR_PUBKEY_REGEX.test('G' + 'A'.repeat(54))).toBe(false);
    expect(STELLAR_PUBKEY_REGEX.test('G' + 'A'.repeat(56))).toBe(false);
    expect(STELLAR_PUBKEY_REGEX.test('G')).toBe(false);
    expect(STELLAR_PUBKEY_REGEX.test('')).toBe(false);
  });

  it('rejects secret seeds (S...)', () => {
    expect(STELLAR_PUBKEY_REGEX.test('S' + 'A'.repeat(55))).toBe(false);
  });

  it('rejects non-base32 characters (0, 1, 8, 9, lowercase)', () => {
    expect(STELLAR_PUBKEY_REGEX.test('G' + 'A'.repeat(54) + '0')).toBe(false);
    expect(STELLAR_PUBKEY_REGEX.test('G' + 'A'.repeat(54) + '1')).toBe(false);
    expect(STELLAR_PUBKEY_REGEX.test('G' + 'A'.repeat(54) + '8')).toBe(false);
    expect(STELLAR_PUBKEY_REGEX.test('G' + 'A'.repeat(54) + '9')).toBe(false);
    expect(STELLAR_PUBKEY_REGEX.test('G' + 'a'.repeat(55))).toBe(false);
  });

  it('anchors both ends — no substring matches', () => {
    expect(STELLAR_PUBKEY_REGEX.test(` ${VALID_G}`)).toBe(false);
    expect(STELLAR_PUBKEY_REGEX.test(`${VALID_G}\n`)).toBe(false);
    expect(STELLAR_PUBKEY_REGEX.test(`x${VALID_G}x`)).toBe(false);
  });
});
