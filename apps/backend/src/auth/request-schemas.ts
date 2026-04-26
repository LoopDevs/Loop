/**
 * A2-803 (auth slice): single source of truth for the three POST
 * `/api/auth/*` request-body shapes that both the CTX-proxy
 * (`handler.ts`) and Loop-native (`native.ts`) handlers parse.
 *
 * Before this module both handlers declared the same
 * `RequestOtpBody` / `VerifyOtpBody` / `RefreshBody` zod schemas
 * verbatim — each one a 5-line drift surface that the audit (A2-803)
 * flagged. Consolidating inside the backend keeps the schemas
 * server-only (no `@loop/shared` zod-dep churn) while giving both
 * paths one place to update if the wire shape changes.
 *
 * `PlatformEnum` defaults to `'web'` so older clients that omit the
 * field continue to verify; both paths read this value to pick the
 * right CTX client ID for downstream provisioning.
 */
import { z } from 'zod';

export const PlatformEnum = z.enum(['web', 'ios', 'android']).default('web');

export const RequestOtpBody = z.object({
  email: z.string().email(),
  platform: PlatformEnum,
});

export const VerifyOtpBody = z.object({
  email: z.string().email(),
  otp: z.string().min(1),
  platform: PlatformEnum,
});

export const RefreshBody = z.object({
  refreshToken: z.string().min(1),
  platform: PlatformEnum,
});
