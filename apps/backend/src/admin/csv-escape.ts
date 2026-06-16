/**
 * CSV escaping for admin exporters (A2-1602).
 *
 * CF-26 / X-PRIV-11: the implementation moved to the shared
 * `../csv/csv-escape.ts` so the user-side cashback-history CSV and the
 * quarterly-tax operator script — which previously defined narrower
 * RFC-4180-only escapers without the formula-injection guard — can
 * import the same hardened source of truth. This module re-exports for
 * the 18 admin exporters that import `./csv-escape.js`, so no admin
 * call site churns.
 */
export { csvEscape, csvRow } from '../csv/csv-escape.js';
