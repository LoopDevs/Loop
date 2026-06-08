import type { Route } from './+types/onboarding';
import { OnboardingDesktop } from '~/components/features/onboarding/OnboardingDesktop';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Welcome to Loop' }];
}

/**
 * `/onboarding` — the web sign-up entry point.
 *
 *   - `lg+`: a split layout — the animated marketing screens on the
 *     left (with arrows), email → verification-code capture on the
 *     right.
 *   - `<lg`: just the sign-up form (no slideshow) — a single clean
 *     screen rather than the native app's multi-screen walkthrough.
 *
 * The native app's full onboarding walkthrough (`Onboarding`) is
 * rendered directly from root.tsx for native users; it isn't used on
 * the web route.
 */
export default function OnboardingRoute(): React.JSX.Element {
  return <OnboardingDesktop />;
}
