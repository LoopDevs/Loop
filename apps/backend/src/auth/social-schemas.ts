/**
 * Canonical request-body schema for the social-login endpoints
 * (`POST /api/auth/social/{google,apple}`) — the SINGLE source both the
 * handler (`social.ts`, which `.parse()`s it) and the OpenAPI spec
 * (`openapi/auth-social.ts`, which registers it) use.
 *
 * D1 (derive OpenAPI from handler Zod schemas): extracted from
 * `social.ts`'s former inline `Body` so the spec's request shape is the
 * handler's validated shape by construction — no re-declaration, no
 * drift. `z` comes from `../openapi-zod.js` so `.openapi()` is available
 * (see that module). Same schema-only pattern as `request-schemas.ts`.
 */
import { z } from '../openapi-zod.js';

export const SocialLoginBody = z.object({
  idToken: z.string().min(1),
  platform: z.enum(['web', 'ios', 'android']).default('web'),
});
