// A2-803: shared auth request-body schemas for CTX-proxy and Loop-native handlers
import { z } from 'zod';

export const PlatformEnum = z.enum(['web', 'ios', 'android']).default('web');

export const CountryCodeField = z
  .string()
  .trim()
  .length(2)
  .transform((value) => value.toUpperCase())
  .optional();

export const RequestOtpBody = z.object({
  email: z.string().email(),
  platform: PlatformEnum,
});

export const VerifyOtpBody = z.object({
  email: z.string().email(),
  otp: z.string().min(1),
  platform: PlatformEnum,
  country: CountryCodeField,
});

export const RefreshBody = z.object({
  refreshToken: z.string().min(1),
  platform: PlatformEnum,
});
