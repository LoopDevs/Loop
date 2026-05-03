/**
 * Social-login OpenAPI registrations (ADR 014).
 *
 * Lifted out of `apps/backend/src/openapi/auth.ts` so the two
 * social-login paths and their two shared body / response schemas
 * sit together separate from the OTP / refresh / logout flows in
 * the parent file:
 *
 *   - POST /api/auth/social/google
 *   - POST /api/auth/social/apple
 *
 * Both paths share the same `SocialLoginBody` (id_token + platform)
 * and `SocialLoginResponse` (access + refresh + email) shapes —
 * the handler factory in `auth/social.ts` wires both providers to
 * the same shape, so the OpenAPI registrations mirror that.
 *
 * `errorResponse` and `platformEnum` are threaded in from the
 * parent factory so the registered component instances stay
 * shared across the wider auth surface.
 *
 * Re-invoked from `registerAuthOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/auth/social/google` and `/api/auth/social/apple`
 * plus their two shared schemas on the supplied registry.
 */
export function registerAuthSocialOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  platformEnum: z.ZodEnum<{ web: 'web'; ios: 'ios'; android: 'android' }>,
): void {
  // A2-568: social login (ADR 014). Body + response are shared
  // across Google and Apple — the handler factory in
  // `auth/social.ts` wires both to the same shape.
  const SocialLoginBody = registry.register(
    'SocialLoginBody',
    z.object({
      idToken: z.string().min(1),
      platform: platformEnum.default('web'),
    }),
  );

  const SocialLoginResponse = registry.register(
    'SocialLoginResponse',
    z.object({
      accessToken: z.string(),
      refreshToken: z.string(),
      email: z.string().email().openapi({
        description:
          "Echo of the verified provider email so the client doesn't decode the access JWT.",
      }),
    }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/auth/social/google',
    summary: 'Sign in with a Google id_token (ADR 014).',
    description:
      "Loop-native only. Server-side verification checks the id_token against Google's JWKS, matches audience against the configured client id per platform, and uses the verified email + sub to resolve or create the Loop user row. On success, Loop mints the same access + refresh shape as `/api/auth/verify-otp`.",
    tags: ['Auth'],
    request: { body: { content: { 'application/json': { schema: SocialLoginBody } } } },
    responses: {
      200: {
        description: 'Token pair issued',
        content: { 'application/json': { schema: SocialLoginResponse } },
      },
      400: {
        description: 'Validation error',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'id_token invalid, expired, or audience mismatch',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description:
          'Loop-native auth disabled or Google audiences not configured in this deployment (`NOT_FOUND`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Auth misconfigured (LOOP_AUTH_NATIVE_ENABLED without signing key) or unexpected server error',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description:
          'Auth subsystem disabled by runtime kill switch (`SUBSYSTEM_DISABLED`) or Google/JWKS auth infrastructure temporarily unavailable (`SERVICE_UNAVAILABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/auth/social/apple',
    summary: 'Sign in with an Apple id_token (ADR 014).',
    description:
      "Loop-native only. Server-side verification checks the id_token against Apple's JWKS, matches audience against the configured Apple client id, and uses the verified email + sub to resolve or create the Loop user row. On success, Loop mints the same access + refresh shape as `/api/auth/verify-otp`.",
    tags: ['Auth'],
    request: { body: { content: { 'application/json': { schema: SocialLoginBody } } } },
    responses: {
      200: {
        description: 'Token pair issued',
        content: { 'application/json': { schema: SocialLoginResponse } },
      },
      400: {
        description: 'Validation error',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'id_token invalid, expired, or audience mismatch',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description:
          'Loop-native auth disabled or Apple Sign In is not configured in this deployment (`NOT_FOUND`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Auth misconfigured (LOOP_AUTH_NATIVE_ENABLED without signing key) or unexpected server error',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description:
          'Auth subsystem disabled by runtime kill switch (`SUBSYSTEM_DISABLED`) or Apple/JWKS auth infrastructure temporarily unavailable (`SERVICE_UNAVAILABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
