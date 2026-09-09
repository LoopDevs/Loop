/**
 * Admin user search.
 *
 * `GET /api/admin/users/search?q=<email-fragment>` — case-insensitive
 * substring match on email. Closes the navigation gap on the admin
 * surface: ops can drill into a user from an order, but the only way
 * to find one from scratch (support chat: "user@example.com says their
 * card never arrived") would otherwise be to hunt through orders.
 *
 * Search policy:
 *   - Minimum 2 chars. Shorter queries match too much to be useful and
 *     would scan the whole collection for nothing; reject with 400.
 *   - Maximum 254 chars (RFC 5321 email length cap).
 *   - Substring anywhere in the email. Starts-with would be cheaper,
 *     but ops often only remembers the domain or a name fragment.
 *   - 20 results. A broader match means the operator should narrow the
 *     query, not that we should stream thousands of rows to the UI.
 *   - Newest signup first, which lines up with the "user just signed
 *     up, please check their account" case.
 *
 * Returns a thin view — enough to disambiguate and click through to
 * the drill-down at `/api/admin/users/:userId`.
 */
import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { db } from '../db/client.js';
import { containsFilter } from '../db/store.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-user-search' });

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 254;
// Exported so the read-audit tests can assert the ADMIN-02 per-path
// bulk threshold stays below this endpoint's own row cap, rather than
// repeating a literal that could silently drift out of sync.
export const RESULT_LIMIT = 20;

export interface AdminUserSearchResult {
  id: string;
  email: string;
  isAdmin: boolean;
  homeCurrency: string;
  createdAt: string;
}

export interface AdminUserSearchResponse {
  users: AdminUserSearchResult[];
  /**
   * Informational — narrow the query when true. Not a total count
   * (expensive), just a hint that more matches exist past the cap.
   */
  truncated: boolean;
}

/** GET /api/admin/users/search */
export async function adminUserSearchHandler(c: Context): Promise<Response> {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < MIN_QUERY_LENGTH) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: `q must be at least ${MIN_QUERY_LENGTH} characters` },
      400,
    );
  }
  if (q.length > MAX_QUERY_LENGTH) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: `q must be at most ${MAX_QUERY_LENGTH} characters` },
      400,
    );
  }

  // The raw email fragment is PII: the read-audit sanitizer redacts
  // `q` before query strings leave the process, so this handler's own
  // log lines must not reintroduce it. A short stable hash plus the
  // length lets ops correlate repeated searches without the term
  // being retained off-host.
  const qHash = createHash('sha256').update(q).digest('hex').slice(0, 16);
  const qLength = q.length;

  try {
    // Fetch one extra row to detect truncation without a second count.
    const rows = await db
      .collection('users')
      .findMany(
        { email: containsFilter(q) },
        { sort: [['createdAt', 'desc']], limit: RESULT_LIMIT + 1 },
      );

    const truncated = rows.length > RESULT_LIMIT;
    const trimmed = truncated ? rows.slice(0, RESULT_LIMIT) : rows;

    const results: AdminUserSearchResult[] = trimmed.map((r) => ({
      id: r.id,
      email: r.email,
      isAdmin: r.isAdmin,
      homeCurrency: r.homeCurrency,
      createdAt: r.createdAt.toISOString(),
    }));

    log.debug({ qHash, qLength, hits: results.length, truncated }, 'admin user-search served');
    return c.json<AdminUserSearchResponse>({ users: results, truncated });
  } catch (err) {
    // A2-507: keep the handler-scoped logger bindings rather than
    // letting the global onError swallow them — ops correlates a
    // failed search to this line via the request id.
    log.error({ err, qHash, qLength }, 'admin user-search query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to search users' }, 500);
  }
}
