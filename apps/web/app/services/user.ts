/**
 * User-profile API (ADR 015).
 *
 * Thin wrappers over the backend's `/api/users/me*` surface. Kept
 * narrow — adding more profile fields later adds more functions
 * here rather than a single bloated "me" service.
 */
import { authenticatedRequest } from './api-client';

export interface UserMeView {
  id: string;
  email: string;
  isAdmin: boolean;
  homeCurrency: 'USD' | 'GBP' | 'EUR';
  stellarAddress: string | null;
}

/**
 * `POST /api/users/me/home-currency` — onboarding-time picker
 * (ADR 015). Server validates the currency against the enum and
 * returns 409 if the user has already placed an order. The
 * onboarding flow calls this pre-first-order so the 409 branch
 * is practically unreachable; callers still surface it as an
 * error rather than swallowing.
 */
export async function setHomeCurrency(code: 'USD' | 'GBP' | 'EUR'): Promise<UserMeView> {
  return authenticatedRequest<UserMeView>('/api/users/me/home-currency', {
    method: 'POST',
    body: { currency: code },
  });
}
