// A2-803: shared auth request-body schemas
import { z } from 'zod';

export const CountryCodeField = z
  .string()
  .trim()
  .length(2)
  .transform((value) => value.toUpperCase())
  .optional();

export const RequestOtpBody = z.object({
  email: z.string().email(),
});

export const VerifyOtpBody = z.object({
  email: z.string().email(),
  otp: z.string().min(1),
  country: CountryCodeField,
});

export const RefreshBody = z.object({
  refreshToken: z.string().min(1),
});
