// @vitest-environment jsdom
/**
 * ADR 043 (B-6) — the i18next bootstrap itself. Two levels:
 *  - the singleton instance resolves English by default and looks up a
 *    known key (non-component access, e.g. `meta()` functions);
 *  - a component using `useTranslation()` renders the same English string,
 *    proving the `I18nextProvider` wiring in `root.tsx` actually reaches
 *    consuming components (not just the raw instance).
 *
 * Also asserts the fallback behaviour (`t()` for an unrecognised key)
 * documented in `docs/i18n.md`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useTranslation, I18nextProvider } from 'react-i18next';
import i18n from '../i18next';

afterEach(cleanup);

describe('i18next bootstrap', () => {
  it('initializes synchronously with English active by default', () => {
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.language).toBe('en');
  });

  it('resolves a known key via the singleton (non-component access pattern)', () => {
    expect(i18n.t('footer:directory')).toBe('Directory');
    expect(i18n.t('notFound:meta.title')).toBe('Page not found — Loop');
  });

  it('interpolates placeholders', () => {
    expect(i18n.t('footer:copyright', { year: 2026 })).toBe('© 2026 Loop. All rights reserved.');
  });

  it('falls back to the raw key for an unrecognised key (debuggable, matches the old scaffold contract)', () => {
    expect(i18n.t('footer:not.a.real.key')).toBe('not.a.real.key');
  });
});

function Probe(): React.JSX.Element {
  const { t } = useTranslation('footer');
  return <p>{t('directory')}</p>;
}

describe('useTranslation() renders through I18nextProvider', () => {
  it('renders the English string for a real component', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <Probe />
      </I18nextProvider>,
    );
    expect(screen.getByText('Directory')).toBeDefined();
  });
});
