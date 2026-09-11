// CSV escaping for admin exporters — A2-1602, CF-26, X-PRIV-11, A2-1523

const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r']);

// Numeric literals are exempt from formula-injection guard to preserve data type for SUM/sort
const NUMERIC_LITERAL = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;

export function csvEscape(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  let v = value;
  if (v.length > 0 && FORMULA_PREFIXES.has(v[0]!) && !NUMERIC_LITERAL.test(v)) {
    v = `'${v}`;
  }
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

export function csvRow(fields: readonly (string | null | undefined)[]): string {
  return fields.map(csvEscape).join(',');
}
