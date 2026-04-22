/**
 * Social-login provider enum (ADR 014).
 *
 * Mirrors the CHECK constraint on `user_identities.provider`. Backend
 * social handlers, auth middleware, and web social-login buttons all
 * read from this list — one source so "added LinkedIn to backend,
 * forgot the button" doesn't become a class of bug.
 */

export const SOCIAL_PROVIDERS = ['google', 'apple'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

/** Narrowing helper for server responses that carry `provider` as a string. */
export function isSocialProvider(value: string): value is SocialProvider {
  return (SOCIAL_PROVIDERS as ReadonlyArray<string>).includes(value);
}
