const REDACTED = '[REDACTED]';
const PII_QUERY_KEYS = new Set(['email', 'q']);

/**
 * CF-10: a non-CSV admin GET whose JSON body carries at least this
 * many list rows is treated as a "bulk read" and fires the same
 * #admin-audit Discord tripwire as a `.csv` export.
 *
 * Most admin list endpoints clamp `?limit=` at 100 (users / top-users
 * / recycling-activity / payouts) with small defaults (20–50). A
 * single near-max page (≥50 rows) is the fingerprint of a cursor-
 * walking PII pull — exactly the exfil pattern the original A2-2008
 * tripwire was meant to catch but only wired for the `.csv` path.
 * Small drills and filtered queries stay below the threshold and
 * remain log-only, so the channel keeps its signal-to-noise.
 */
export const BULK_LIST_ROW_THRESHOLD = 50;

/**
 * CF-10: counts the list rows in an admin JSON response body so the
 * read-audit middleware can flag bulk JSON pulls (not just `.csv`
 * exports) to #admin-audit.
 *
 * Admin list endpoints return a JSON object with the rows under a
 * single array property (`users`, `rows`, `payouts`, `orders`,
 * `transactions`, …). Rather than hard-code every key — which would
 * silently miss new endpoints — we take the length of the largest
 * top-level array in the body. Scalar / object-only responses
 * (single-row drills, snapshots) count as 0 and never trip the wire.
 *
 * Returns 0 (never throws) for non-JSON content types, unparseable
 * bodies, or bodies with no top-level array — a malformed body must
 * never break the response path the middleware wraps.
 */
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
  if (Array.isArray(parsed)) return parsed.length;
  let max = 0;
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (Array.isArray(value) && value.length > max) max = value.length;
  }
  return max;
}

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
