/**
 * `t()` — the string-translation seam (ADR 034 Phase 1).
 *
 * ⚠️ PHASE-2 SCAFFOLD — intentionally not wired (cold-audit CF-22). Loop ships a
 * single language today (`SUPPORTED_LANGS = ['en']`), so there is nothing to
 * translate *to*: routing every UI literal through `t()` now would be a ~137-
 * component refactor with zero user-visible effect. This seam is kept as the
 * forward-compatible landing spot so that *adding* a language later (ADR 034 §7's
 * "`/de/de` is a catalogue drop, not a refactor") is a real, small change rather
 * than a from-scratch extraction. The string-extraction itself is deliberately
 * deferred to the first non-`en` locale (ADR 034 Phase 3 — see the ADR's "i18n
 * seam status" note). Do NOT mass-extract copy through `t()` while only `en`
 * exists. Locale-aware *number/date/currency* formatting is a separate, fully
 * live seam (`i18n/format.ts`).
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
