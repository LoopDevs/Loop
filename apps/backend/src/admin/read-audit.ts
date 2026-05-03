const REDACTED = '[REDACTED]';
const PII_QUERY_KEYS = new Set(['email', 'q']);

/**
 * Redacts PII-bearing admin query params before they leave the
 * process via log shipping or Discord audit notifies. We keep the
 * key names so operators can still tell which filter surface was
 * used, but the search term itself is not retained off-host.
 */
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
