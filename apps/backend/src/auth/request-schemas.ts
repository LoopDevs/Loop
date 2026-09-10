// A2-803: shared auth request-body schemas for CTX-proxy and Loop-native handlers
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
