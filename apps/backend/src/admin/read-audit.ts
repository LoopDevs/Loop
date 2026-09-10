const REDACTED = '[REDACTED]';
const PII_QUERY_KEYS = new Set(['email', 'q']);

// CF-10: ≥50 rows in a non-CSV admin GET fires #admin-audit tripwire (A2-2008)
export const BULK_LIST_ROW_THRESHOLD = 50;

// ADMIN-02: `admin/users/search` caps at 20 rows, bypassing global threshold; override ensures full pages trip the wire
export const PER_PATH_BULK_ROW_THRESHOLD: Readonly<Record<string, number>> = {
  '/api/admin/users/search': 15,
};

export function bulkRowThresholdFor(path: string): number {
  return PER_PATH_BULK_ROW_THRESHOLD[path] ?? BULK_LIST_ROW_THRESHOLD;
}

// CF-10: counts max array depth in JSON body to flag bulk reads; explicit stack prevents stack overflow on hostile nesting
export function countAdminListRows(body: string, contentType: string | null): number {
  if (contentType === null || !contentType.toLowerCase().includes('application/json')) {
    return 0;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 0;
  }
  if (parsed === null || typeof parsed !== 'object') return 0;
  let max = 0;
  const stack: unknown[] = [parsed];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      if (node.length > max) max = node.length;
      for (const el of node) {
        if (el !== null && typeof el === 'object') stack.push(el);
      }
    } else if (node !== null && typeof node === 'object') {
      for (const value of Object.values(node as Record<string, unknown>)) {
        if (value !== null && typeof value === 'object') stack.push(value);
      }
    }
  }
  return max;
}

// Redacts PII query params before log shipping/Discord notifies; keeps keys, replaces values
export function sanitizeAdminReadQueryString(queryString: string): string | undefined {
  if (queryString.length === 0) return undefined;
  const params = new URLSearchParams(queryString);
  let touched = false;
  for (const key of PII_QUERY_KEYS) {
    const values = params.getAll(key);
    if (values.length === 0) continue;
    touched = true;
    params.delete(key);
    for (let i = 0; i < values.length; i++) {
      params.append(key, REDACTED);
    }
  }
  const rendered = params.toString();
  if (rendered.length === 0) return undefined;
  return touched ? rendered : queryString;
}
