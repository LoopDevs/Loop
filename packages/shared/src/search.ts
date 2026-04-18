/**
 * Accent- and case-insensitive fold for merchant search strings.
 *
 * Canonicalizes to NFD (decomposes accented chars into base + combining
 * mark), drops the combining-diacritic block (U+0300–U+036F), then
 * lowercases. Result: `cafe` matches `Café`, `dunkin` matches `Dunkin'`.
 *
 * Used by both the backend (`/api/merchants?q=`) and the web navbar
 * search (client-side filter over the full catalog). Keeping this in
 * `@loop/shared` means both paths produce the same result for the same
 * query — otherwise a user searching "cafe" would find merchants via
 * one path and miss them via the other.
 */
export function foldForSearch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
