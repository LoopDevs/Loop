import type { Route } from './+types/onboarding';
import { Onboarding } from '~/components/features/onboarding/Onboarding';
import { OnboardingDesktop } from '~/components/features/onboarding/OnboardingDesktop';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Welcome to Loop' }];
}

/**
 * `/onboarding` — first-launch / sign-up flow.
 *
 * Two presentations, picked by width:
 *   - `<lg` (phones, native webview): the multi-screen mobile flow
 *     (`Onboarding`, `fixed inset-0`, its own footer CTA). The
 *     `lg:hidden` wrapper hides its fixed children at desktop widths.
 *   - `lg+` (desktop web): a split layout — marketing slideshow on the
 *     left, email → verification-code capture on the right.
 *
 * Native always renders the mobile flow directly from root.tsx; this
 * route is the web entry point.
 */
export default function OnboardingRoute(): React.JSX.Element {
  return (
    <>
      <div className="lg:hidden">
        <Onboarding />
      </div>
      <div className="hidden lg:block">
        <OnboardingDesktop />
      </div>
    </>
  );
}
