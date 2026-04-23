/**
 * Admin user search (ADR 011 — admin panel navigation).
 *
 * `GET /api/admin/users/search?q=<email-fragment>` — case-insensitive
 * email prefix / substring match. Closes the last navigation gap on
 * the admin surface: today ops can drill into a user from
 * `/admin/orders?userId=...` or `/admin/payouts?userId=...`, but the
 * only way to find a user from scratch (support chat: "user@example.com
 * says their cashback didn't land") was to hunt through recent orders.
 *
 * Search policy:
 *   - Minimum 2 chars. Shorter queries match too much to be useful
 *     and would scan the entire users table; reject with 400.
 *   - Maximum 254 chars (RFC 5321 email length cap).
 *   - ILIKE `%q%` — substring anywhere in the email. Starts-with
 *     would be faster but ops often only remembers the domain or
 *     a username fragment.
 *   - Limit 20 results. A broader match is a sign the operator
 *     should narrow the query, not that we should stream thousands
 *     of rows to the UI.
 *   - Ordered by `created_at DESC` so the most-recently-signed-up
 *     matches appear first, which lines up with "user just signed
 *     up, please check their account" cases.
 *
 * Returns a thin view — enough to disambiguate + click through to
 * `/admin/users/:id` for full detail. Deliberately excludes
 * `stellarAddress`, `ctxUserId`, balances — those live on the
 * drill-down endpoint (ADR 017).
 */
import type { Context } from 'hono';
import { desc, ilike } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-user-search' });

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 254;
const RESULT_LIMIT = 20;

export interface AdminUserSearchResult {
  id: string;
  email: string;
  isAdmin: boolean;
  homeCurrency: 'USD' | 'GBP' | 'EUR';
  createdAt: string;
}

export interface AdminUserSearchResponse {
  users: AdminUserSearchResult[];
  /**
   * Informational — clients should paginate / narrow the query when
   * this is true. Not a "total count" (expensive on large tables),
   * just a hint that more matches exist beyond the cap.
   */
  truncated: boolean;
}

/** GET /api/admin/users/search */
export async function adminUserSearchHandler(c: Context): Promise<Response> {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < MIN_QUERY_LENGTH) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: `q must be at least ${MIN_QUERY_LENGTH} characters`,
      },
      400,
    );
  }
  if (q.length > MAX_QUERY_LENGTH) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: `q must be at most ${MAX_QUERY_LENGTH} characters` },
      400,
    );
  }

  // ILIKE wildcards are `%` / `_`; escape them from the user's input
  // so a search for `a_b` doesn't match `axb`. Drizzle's `ilike`
  // helper takes the full pattern string, so we do the escape here
  // before composing the `%q%` wrapper.
  const escaped = q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
  const pattern = `%${escaped}%`;

  // Fetch one extra row to detect truncation without a COUNT(*).
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      isAdmin: users.isAdmin,
      homeCurrency: users.homeCurrency,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(ilike(users.email, pattern))
    .orderBy(desc(users.createdAt))
    .limit(RESULT_LIMIT + 1);

  const truncated = rows.length > RESULT_LIMIT;
  const trimmed = truncated ? rows.slice(0, RESULT_LIMIT) : rows;

  const results: AdminUserSearchResult[] = trimmed.map((r) => ({
    id: r.id,
    email: r.email,
    isAdmin: r.isAdmin,
    // DB CHECK constrains this; the cast is load-bearing for the wire type only.
    homeCurrency: r.homeCurrency as 'USD' | 'GBP' | 'EUR',
    createdAt: r.createdAt.toISOString(),
  }));

  log.debug({ q, hits: results.length, truncated }, 'admin user-search served');
  return c.json<AdminUserSearchResponse>({ users: results, truncated });
}
