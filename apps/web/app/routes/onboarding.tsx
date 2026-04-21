import type { Route } from './+types/onboarding';
import { Onboarding } from '~/components/features/onboarding/Onboarding';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Welcome to Loop' }];
}

/**
 * `/onboarding` — six-screen first-launch flow (welcome, how-it-
 * works, brands, email, OTP, welcome-in). Rendered full-bleed — the
 * Onboarding component itself uses `fixed inset-0` and runs its own
 * footer CTA, so the route module just mounts it. No Navbar here:
 * the top-level Navbar is rendered by individual routes (home, map,
 * orders), and onboarding opts out by not mounting it.
 */
export default function OnboardingRoute(): React.JSX.Element {
  return <Onboarding />;
}
