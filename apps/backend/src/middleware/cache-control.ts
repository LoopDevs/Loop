/**
 * Cache-Control header middleware factory. Pulled out of `app.ts`
 * (six inline copies of the same `await next(); c.header(...)`
 * shape across `/api/auth`, `/api/orders`, `/api/users/me`,
 * `/api/admin`).
 *
 * Why these endpoints set Cache-Control on every response — even
 * 401s and error envelopes:
 *
 * **`no-store`** on `/api/auth/*` — auth responses contain
 * freshly-minted access/refresh tokens. A misconfigured
 * intermediate proxy that treats any HTTP response as cacheable
 * (defying the spec, but it happens) could otherwise hand one
 * user's tokens to the next caller of the same URL.
 *
 * **`private, no-store`** on `/api/orders`, `/api/users/me`,
 * `/api/admin` — these contain user-specific data: order history,
 * profile, admin payloads. A CDN or proxy keyed on URL alone
 * (not Authorization) could cache one user's response and serve
 * it to another user's next request. Fly.io itself doesn't
 * proxy-cache, but this removes the footgun before any future
 * edge caching is introduced. `private` adds the explicit
 * "shared caches MUST NOT store" signal alongside `no-store`.
 *
 * **Mount order matters**: register these BEFORE `requireAuth`
 * so the header still applies on the 401 response that
 * `requireAuth` emits when no Bearer is present — a misbehaving
 * CDN that caches 401s shouldn't leak the "this URL needs auth"
 * shape across requests.
 */
import type { Context } from 'hono';

/**
 * Stamps `Cache-Control: no-store` on the response after the
 * handler resolves. Use on `/api/auth/*` where responses contain
 * minted credentials.
 */
export async function noStoreResponse(c: Context, next: () => Promise<void>): Promise<void> {
  await next();
  c.header('Cache-Control', 'no-store');
}

/**
 * Stamps `Cache-Control: private, no-store` on the response after
 * the handler resolves. Use on user-specific endpoints
 * (`/api/orders`, `/api/users/me`, `/api/admin/*`) where one
 * user's response must never be served to another user.
 */
export async function privateNoStoreResponse(c: Context, next: () => Promise<void>): Promise<void> {
  await next();
  c.header('Cache-Control', 'private, no-store');
}
