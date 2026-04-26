/**
 * A2-1165 (slice 23): admin users directory + detail surface
 * extracted from `services/admin.ts`. Three reads back the user-
 * directory tab and the user-detail header (ADR 011 / 013):
 *
 * - `GET /api/admin/users` — paginated admin directory with
 *   email-fragment search. ILIKE-based on email and id; cursor
 *   via `before=<iso>`.
 * - `GET /api/admin/users/:userId` — single user drill-down
 *   header. Surfaces `homeCurrency`, `stellarAddress`,
 *   `ctxUserId`. The drill page composes this with the per-user
 *   slices already extracted (credits in #1119, monthly in #1122,
 *   payment-method-share in #1118, etc.).
 * - `GET /api/admin/users/by-email?email=` — exact-match lookup.
 *   Lower-cased normalisation so `Alice@Example.COM` matches
 *   `alice@example.com`. Complements the fragment search.
 *
 * The `AdminUserRow` / `AdminUserDetail` shapes were inline in
 * `services/admin.ts` and move with the functions. They have no
 * other consumers, so promoting them to `@loop/shared` would
 * just add indirection. `services/admin.ts` keeps a barrel
 * re-export so existing consumers (`AdminUsersTable.tsx`,
 * `routes/admin.users.tsx`, `routes/admin.users.$userId.tsx`,
 * paired tests) don't have to re-target imports.
 */
import { authenticatedRequest } from './api-client';

/** Row shape from `/api/admin/users` (admin directory). */
export interface AdminUserRow {
  id: string;
  email: string;
  isAdmin: boolean;
  homeCurrency: string;
  createdAt: string;
}

/** Full user detail shape from `/api/admin/users/:userId`. */
export interface AdminUserDetail {
  id: string;
  email: string;
  isAdmin: boolean;
  homeCurrency: string;
  stellarAddress: string | null;
  ctxUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/admin/users` — paginated admin directory with email-fragment search. */
export async function listAdminUsers(opts: {
  q?: string;
  limit?: number;
  before?: string;
}): Promise<{ users: AdminUserRow[] }> {
  const params = new URLSearchParams();
  if (opts.q !== undefined && opts.q.length > 0) params.set('q', opts.q);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.before !== undefined) params.set('before', opts.before);
  const qs = params.toString();
  return authenticatedRequest<{ users: AdminUserRow[] }>(
    `/api/admin/users${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/** `GET /api/admin/users/:userId` — single user drill-down header. */
export async function getAdminUser(userId: string): Promise<AdminUserDetail> {
  return authenticatedRequest<AdminUserDetail>(`/api/admin/users/${encodeURIComponent(userId)}`);
}

/**
 * `GET /api/admin/users/by-email?email=` — exact-match lookup with
 * lowercase normalisation. Throws on 404 / 500 via the shared
 * ApiException path; handlers render "no user with that email" for 404.
 */
export async function getAdminUserByEmail(email: string): Promise<AdminUserDetail> {
  return authenticatedRequest<AdminUserDetail>(
    `/api/admin/users/by-email?email=${encodeURIComponent(email)}`,
  );
}
