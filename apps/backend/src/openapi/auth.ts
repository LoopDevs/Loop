/**
 * Auth section of the OpenAPI spec — schemas + path registrations
 * for `POST /api/auth/*` (request-otp, verify-otp, refresh, social
 * login, logout) plus the shared body shapes (`PlatformEnum` is
 * imported from the parent module).
 *
 * First per-domain module of the openapi.ts decomposition. Same
 * pattern as the per-domain route modules under
 * `apps/backend/src/routes/*` — `registerAuthOpenApi(registry)`
 * is a void-returning factory called from `openapi.ts` at the
 * right point in the registration order. Schemas + paths live
 * together because the registerPath blocks reference the local
 * schema constants (`RequestOtpBody`, `VerifyOtpResponse`, etc.)
 * — splitting them across files would require exporting the
 * schemas just to feed them back, with no benefit.
 *
 * `ErrorResponse` is shared across every section and stays
 * registered in `openapi.ts`; this module imports it as a value
 * for the per-status response wiring.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers all `/api/auth/*` schemas + paths on the supplied
 * registry. Called once from `openapi.ts` during module init.
 *
 * `errorResponse` and `platformEnum` are passed in (rather than
 * imported circularly) because they live in the parent
 * `openapi.ts` shared-components block.
 */
export function registerAuthOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  platformEnum: z.ZodEnum<{ web: 'web'; ios: 'ios'; android: 'android' }>,
): void {
  const RequestOtpBody = registry.register(
    'RequestOtpBody',
    z.object({
      email: z.string().email(),
      platform: platformEnum.default('web'),
    }),
  );

  const VerifyOtpBody = registry.register(
    'VerifyOtpBody',
    z.object({
      email: z.string().email(),
      otp: z.string().min(1),
      platform: platformEnum.default('web'),
    }),
  );

  const VerifyOtpResponse = registry.register(
    'VerifyOtpResponse',
    z.object({
      accessToken: z.string(),
      refreshToken: z.string(),
    }),
  );

  const RefreshBody = registry.register(
    'RefreshBody',
    z.object({
      refreshToken: z.string().min(1),
      platform: platformEnum.default('web'),
    }),
  );

  const RefreshResponse = registry.register(
    'RefreshResponse',
    z.object({
      accessToken: z.string(),
      refreshToken: z.string().optional().openapi({
        description: 'Present when upstream rotates the refresh token on refresh.',
      }),
    }),
  );

  const LogoutBody = registry.register(
    'LogoutBody',
    z.object({
      refreshToken: z.string().optional(),
      platform: platformEnum.default('web'),
    }),
  );

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
    path: '/api/auth/request-otp',
    summary: 'Request a one-time password be emailed to the given address.',
    description:
      'Email-enumeration defense: returns 200 with "Verification code sent" even when upstream responds with 4xx (e.g. "no such user"). Clients cannot distinguish "email was accepted" from "email was rejected as unknown" by the response status. Only 5xx upstream errors surface as 502 so legitimate users are not left waiting on real outages.',
    tags: ['Auth'],
    request: { body: { content: { 'application/json': { schema: RequestOtpBody } } } },
    responses: {
      200: {
        description:
          'OTP queued upstream — OR, by design, email rejected upstream with a 4xx (see description for enumeration-defense rationale).',
        content: { 'application/json': { schema: z.object({ message: z.string() }) } },
      },
      400: {
        description: 'Validation error',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (5/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Loop-native auth misconfigured (LOOP_AUTH_NATIVE_ENABLED without signing key) or an unexpected backend failure — A2-1001',
        content: { 'application/json': { schema: errorResponse } },
      },
      502: {
        description: 'Upstream OTP send failed',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Upstream auth circuit open',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/auth/verify-otp',
    summary: 'Exchange an emailed OTP for an access + refresh token pair.',
    tags: ['Auth'],
    request: { body: { content: { 'application/json': { schema: VerifyOtpBody } } } },
    responses: {
      200: {
        description: 'Token pair issued',
        content: { 'application/json': { schema: VerifyOtpResponse } },
      },
      400: {
        description: 'Validation error',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'OTP invalid or expired',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Loop-native auth misconfigured (LOOP_AUTH_NATIVE_ENABLED without signing key) or an unexpected backend failure — A2-1001',
        content: { 'application/json': { schema: errorResponse } },
      },
      502: {
        description: 'Upstream OTP verify failed',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Upstream auth circuit open',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/auth/refresh',
    summary: 'Exchange a refresh token for a new access token (and possibly a rotated refresh).',
    tags: ['Auth'],
    request: { body: { content: { 'application/json': { schema: RefreshBody } } } },
    responses: {
      200: {
        description: 'Refresh succeeded',
        content: { 'application/json': { schema: RefreshResponse } },
      },
      400: {
        description: 'Validation error',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Refresh token invalid or expired',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (30/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      502: {
        description: 'Upstream refresh failed',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Upstream auth circuit open',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/auth/session',
    summary: 'Revoke the caller session (logout).',
    tags: ['Auth'],
    request: { body: { content: { 'application/json': { schema: LogoutBody } } } },
    responses: {
      200: {
        description: 'Logout succeeded',
        content: { 'application/json': { schema: z.object({ message: z.string() }) } },
      },
      400: {
        description: 'Validation error',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      502: {
        description: 'Upstream revoke failed',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/auth/social/google',
    summary: 'Sign in with a Google id_token (ADR 014).',
    description:
      "Server-side verification: the id_token is checked against Google's JWKS, the audience is matched against the configured client id per platform, and the verified email + sub are used to upsert the Loop user row. Returns the same access + refresh shape as /api/auth/verify-otp.",
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
        description: 'Google JWKS unreachable — retry-safe',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/auth/social/apple',
    summary: 'Sign in with an Apple id_token (ADR 014).',
    description:
      "Server-side verification: the id_token is checked against Apple's JWKS, the audience is matched against the configured Apple client id, and the verified email + sub are used to upsert the Loop user row. Returns the same access + refresh shape as /api/auth/verify-otp.",
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
        description: 'Apple JWKS unreachable — retry-safe',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
