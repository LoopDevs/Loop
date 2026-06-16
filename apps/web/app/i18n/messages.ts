/**
 * Message catalogue (ADR 034 Phase 1).
 *
 * ⚠️ PHASE-2 SCAFFOLD — see the header note in `./t.ts` (cold-audit CF-22). This
 * is the `t()` seam's data, seeded with a representative slice rather than an
 * exhaustive extraction. It stays small *on purpose* while `SUPPORTED_LANGS` is
 * `['en']` — there is no second language to translate to, so a full extraction
 * would be churn with no user-visible effect. The exhaustive extraction lands
 * with the first non-`en` locale (ADR 034 Phase 3).
 *
 * Route UI copy lives here as keyed strings rather than inline literals so that
 * adding a language later (`/de/de`) is a JSON drop, not a refactor (ADR 034 §7).
 * We deliberately ship **no** heavy i18n library on day one — just the
 * discipline of keys + a thin `t()` (see `./t.ts`).
 *
 * English is the only catalogue today and is the fallback for any future
 * language that's missing a key. Keys are `area.element` dotted strings. Copy
 * that varies by market uses a `{country}`/`{currency}` placeholder so the same
 * key localises per route (e.g. the home tagline reads "…in the UK").
 */

export const messages = {
  en: {
    'home.hero.title': 'Earn cashback on every gift card',
    'home.hero.subtitle': 'Buy discounted gift cards and earn Loop cashback{inCountry}.',
    'home.cta.start': "Get started — it's free",
    'nav.search.placeholder': 'Search brands',
    'country.modal.title': 'Choose your country',
    'country.modal.search': 'Search countries',
    'merchant.savings': '{percent}% off',
  },
} as const;

/** The language catalogues we ship. Mirrors `SUPPORTED_LANGS` in `@loop/shared`. */
export type CatalogueLang = keyof typeof messages;

/** Every message key (derived from the English catalogue — the canonical set). */
export type MessageKey = keyof (typeof messages)['en'];
