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
 * ADMIN-02 (2026-06-30 cold audit): `admin/users/search` hard-caps its
 * own response at 20 rows (`user-search.ts`'s `RESULT_LIMIT`), which
 * keeps it permanently BELOW `BULK_LIST_ROW_THRESHOLD` regardless of
 * how broad the query is or how many times it's called — the endpoint
 * can never trip the generic tripwire by construction, defeating the
 * one control (CF-10) meant to catch an admin enumerating the user
 * table's emails via short substrings (`q=aa`, `q=ab`, ...).
 *
 * Stopgap fix: a per-path threshold override, checked below the global
 * `BULK_LIST_ROW_THRESHOLD`. Pinned under this endpoint's own row cap
 * so a full page (a broad query hitting the 20-row ceiling) — the
 * actual enumeration fingerprint — always trips it, while a normal
 * "find this one user" search (1-3 rows) stays log-only.
 *
 * The real fix (tracked separately, larger lift) is a shared,
 * cross-machine per-actor rolling-window row-count accumulator so the
 * tripwire catches cumulative exfiltration regardless of any single
 * endpoint's page size — this map is a targeted patch for the one
 * endpoint that's currently invisible by construction, not a general
 * solution to sub-threshold pagination walks on other list endpoints.
 *
 * A5-8 P2 follow-up: the opposite collision. `GET /api/admin/ledger`
 * (`admin/ledger.ts`) has `DEFAULT_LIMIT = 50` — the SAME value as the
 * global `BULK_LIST_ROW_THRESHOLD` — so EVERY default-size page load
 * (not just a broad/paginated one) trips the tripwire, diluting the
 * CF-10 signal with routine support-triage opens of the page. This
 * override raises the effective threshold for that one path above its
 * own default page size (51 > 50) while leaving it well below the
 * endpoint's real max (`MAX_LIMIT = 200`), so an explicit wide
 * `?limit=` pull still trips it — only the routine default no longer
 * does. Chosen over bumping `admin/ledger.ts`'s `DEFAULT_LIMIT` to 49:
 * that constant is documented as "50" in three other places (the
 * handler doc, the `@loop/shared` response-type doc, and the openapi
 * registration) that a magic-number-49 change would need to ripple
 * through for no behavioural benefit; this map exists for exactly this
 * shape of fix.
 */
export const PER_PATH_BULK_ROW_THRESHOLD: Readonly<Record<string, number>> = {
  '/api/admin/users/search': 15,
  '/api/admin/ledger': 51,
};

/**
 * Returns the effective bulk-row threshold for `path` — the
 * per-path override when one exists, else the global default.
 */
export function bulkRowThresholdFor(path: string): number {
  return PER_PATH_BULK_ROW_THRESHOLD[path] ?? BULK_LIST_ROW_THRESHOLD;
}

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
