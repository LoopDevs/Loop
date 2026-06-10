/**
 * `t()` — the translation seam (ADR 034 Phase 1).
 *
 * A thin, dependency-free, SSR-safe message lookup with `{placeholder}`
 * interpolation. English-only today; the `lang` argument and per-language
 * fallback are the future-proofing so `/de/de` is a catalogue drop, not a code
 * change (ADR 034 §7).
 *
 * Resolution: `messages[lang][key]` → `messages.en[key]` (fallback) → the raw
 * `key` (last resort, so a missing key renders something debuggable rather than
 * blank). Placeholders are `{name}` tokens replaced from `vars`; an unmatched
 * token is left intact.
 */

import { messages, type CatalogueLang, type MessageKey } from './messages.js';

type Vars = Record<string, string | number>;

const FALLBACK_LANG: CatalogueLang = 'en';

function isCatalogueLang(lang: string): lang is CatalogueLang {
  return lang in messages;
}

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/**
 * Resolve a message key for `lang` (default English), interpolating `vars`.
 *
 * `t('merchant.savings', { percent: 5 })` → `'5% off'`.
 */
export function t(key: MessageKey, vars?: Vars, lang: string = FALLBACK_LANG): string {
  const catalogue = isCatalogueLang(lang) ? messages[lang] : messages[FALLBACK_LANG];
  const template: string = catalogue[key] ?? messages[FALLBACK_LANG][key] ?? key;
  return interpolate(template, vars);
}
