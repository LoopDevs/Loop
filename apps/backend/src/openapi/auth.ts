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
import { registerAuthSocialOpenApi } from './auth-social.js';

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

  // `SocialLoginBody` / `SocialLoginResponse` plus the two
  // social-login paths live in `./auth-social.ts`. Re-invoked at
  // the bottom of this factory so OpenAPI path-registration order
  // is preserved.

  registry.registerPath({
    method: 'post',
    path: '/api/auth/request-otp',
    summary: 'Request a one-time password be emailed to the given address.',
    description:
      'Dual-path endpoint. With `LOOP_AUTH_NATIVE_ENABLED=true`, Loop writes the OTP row and sends the email itself; otherwise it proxies CTX `/login`. Email-enumeration defense applies in both modes: the route returns 200 with `Verification code sent` even when the upstream/native path rejects the email or the proxy auth circuit is open. The only documented 503 on this route is the explicit auth kill switch middleware.',
    tags: ['Auth'],
    request: { body: { content: { 'application/json': { schema: RequestOtpBody } } } },
    responses: {
      200: {
        description:
          'OTP accepted on the native path, queued via CTX on the proxy path, or intentionally flattened from a rejection into the generic enumeration-safe envelope.',
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
        description: 'Auth subsystem disabled by runtime kill switch (`SUBSYSTEM_DISABLED`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/auth/verify-otp',
    summary: 'Exchange an emailed OTP for an access + refresh token pair.',
    description:
      'Dual-path endpoint. With `LOOP_AUTH_NATIVE_ENABLED=true`, Loop consumes a local OTP row and mints a Loop-signed access/refresh pair. Otherwise it proxies CTX `/verify-email` and forwards the CTX-issued pair after response validation.',
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
        description:
          'Auth subsystem disabled by runtime kill switch (`SUBSYSTEM_DISABLED`) or CTX auth circuit open on the proxy path (`SERVICE_UNAVAILABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/auth/refresh',
    summary: 'Exchange a refresh token for a new access token (and possibly a rotated refresh).',
    description:
      'Dual-path endpoint. With `LOOP_AUTH_NATIVE_ENABLED=true`, Loop verifies and rotates a Loop-signed refresh JWT. Otherwise it proxies CTX `/refresh-token` and validates the CTX response before forwarding it.',
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

  // The two social-login paths (`/auth/social/google`,
  // `/auth/social/apple`) and their two shared schemas live in
  // `./auth-social.ts`. Same path-registration position as the
  // original block.
  registerAuthSocialOpenApi(registry, errorResponse, platformEnum);
}
