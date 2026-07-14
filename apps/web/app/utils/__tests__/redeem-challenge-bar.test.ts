import { describe, it, expect } from 'vitest';
import { buildChallengeBarScript } from '../redeem-challenge-bar';

describe('buildChallengeBarScript', () => {
  it('JSON-encodes the challenge code so an alphanumeric value is safe to inject', () => {
    const script = buildChallengeBarScript('ABC123');
    expect(script).toContain('"ABC123"');
  });

  it('escapes a value containing quotes / backslashes (the JSON.stringify path)', () => {
    const script = buildChallengeBarScript('a"b\\c');
    // The raw string never appears literally; only the JSON-encoded form does.
    expect(script).not.toContain('a"b\\c');
    expect(script).toContain('"a\\"b\\\\c"');
  });

  it('produces an idempotent IIFE: includes the existing-bar guard so a re-injection is a no-op', () => {
    const script = buildChallengeBarScript('CODE');
    expect(script).toMatch(/document\.getElementById\(['"]loop-challenge-bar['"]\)/);
    expect(script).toContain('return;');
  });

  it('A4-071: surfaces a "Copy failed" label when both clipboard paths fail', () => {
    const script = buildChallengeBarScript('CODE');
    expect(script).toContain('Copy failed');
    expect(script).toContain('execCommand');
  });

  it('uses the max z-index so CSS-heavy merchant sites cannot hide the bar', () => {
    const script = buildChallengeBarScript('CODE');
    expect(script).toContain('2147483647');
  });

  it('FE-32: exposes an aria-live status region for the copy result', () => {
    const script = buildChallengeBarScript('CODE');
    // A dedicated polite/status live node — the button label flip alone is
    // an unreliable screen-reader announcement inside a merchant WebView.
    expect(script).toContain("'aria-live', 'polite'");
    expect(script).toContain("'role', 'status'");
  });

  it('FE-32: announces both the copied and failed states into the live region', () => {
    const script = buildChallengeBarScript('CODE');
    // success and failure each push a message into the live region, not just
    // the visible button text — so SR users hear the outcome.
    expect(script).toContain('Code copied to clipboard');
    expect(script).toContain("live.textContent = 'Copy failed'");
  });
});
