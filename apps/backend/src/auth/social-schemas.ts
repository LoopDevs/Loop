// canonical body schema for social-login — D1
import { z } from 'zod';

export const SocialLoginBody = z.object({
  idToken: z.string().min(1),
  platform: z.enum(['web', 'ios', 'android']).default('web'),
});
