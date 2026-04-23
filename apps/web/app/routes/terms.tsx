import { Link } from 'react-router';
import type { Route } from './+types/terms';
import { Navbar } from '~/components/features/Navbar';
import { Footer } from '~/components/features/Footer';

/**
 * `/terms` — terms of service placeholder (#662).
 *
 * Companion to the privacy-policy placeholder shipped alongside.
 * App Store / Play Store submission gates on a terms-of-service
 * URL as well as a privacy-policy one (roadmap Phase 1 mobile-
 * submission checklist). This ships the structural shell —
 * route, URL, SSR meta — pending legal copy.
 *
 * The placeholder outline covers the sections counsel will fill
 * in per the Stellar / stablecoin context: scope of service,
 * eligibility, account responsibilities, payment + cashback
 * mechanics (Stellar-side), acceptable use, disclaimers +
 * liability, and jurisdiction. Do not treat the placeholder
 * text as binding — this is a structural scaffold only.
 */
export function meta(): Route.MetaDescriptors {
  return [
    { title: 'Terms of Service — Loop' },
    {
      name: 'description',
      content: 'The terms of service for using Loop.',
    },
    { tagName: 'link', rel: 'canonical', href: 'https://loopfinance.io/terms' },
  ];
}

export default function TermsRoute(): React.JSX.Element {
  return (
    <>
      <Navbar />
      <main className="container mx-auto max-w-3xl px-4 py-12">
        <header className="mb-10">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">
            Terms of Service
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Last updated: pending publication
          </p>
        </header>

        <aside
          role="note"
          className="mb-10 rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-900 dark:border-yellow-900/60 dark:bg-yellow-900/20 dark:text-yellow-200"
        >
          These terms are a placeholder pending final legal review. The structural outline below
          reflects the shape of the final document; precise language will be finalised before the
          App Store / Play Store listings go live. Questions:{' '}
          <a href="mailto:legal@loopfinance.io" className="underline hover:no-underline">
            legal@loopfinance.io
          </a>
          .
        </aside>

        <article className="prose prose-gray max-w-none dark:prose-invert text-gray-700 dark:text-gray-300 space-y-6">
          <section>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">1. Service</h2>
            <p>
              Loop is a cashback platform for gift-card purchases. Cashback is paid in LOOP-asset
              stablecoins on the Stellar network, pegged 1:1 to your home currency. Use of the
              service implies acceptance of these terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">2. Eligibility</h2>
            <p>
              You must be at least 18 and legally able to enter a binding contract in your
              jurisdiction. Certain regions may be restricted where the stablecoin payout rails are
              not authorised.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">3. Account</h2>
            <p>
              Your account is keyed on the email address you verify at sign-up. You are responsible
              for safeguarding the device / browser you authenticate from, and for the wallet
              address you link for cashback payouts.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              4. Payments and cashback
            </h2>
            <p>
              Gift-card orders are paid in XLM, USDC, or your existing LOOP- asset balance. Cashback
              is credited at fulfilment and paid to your linked Stellar wallet in the matching LOOP
              stablecoin. On-chain transfers rely on the Stellar network; Loop is not liable for
              delays attributable to the network or to a non-responsive linked wallet.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              5. Acceptable use
            </h2>
            <p>
              No fraud, no resale of gift cards acquired through Loop, no automated account
              creation, no evasion of per-user limits. We reserve the right to suspend accounts that
              breach these rules and to reverse unfulfilled orders where fraud is detected.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              6. Disclaimers and liability
            </h2>
            <p>
              The service is provided on an &ldquo;as is&rdquo; basis. Loop&rsquo;s liability is
              capped at the cashback amount earned in the 12 months preceding a claim, except where
              a higher cap is mandated by consumer-protection law in your jurisdiction.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">7. Jurisdiction</h2>
            <p>
              These terms are governed by the laws of England and Wales; exclusive jurisdiction lies
              with the courts of London for disputes arising under them, without prejudice to
              consumer rights under your local law.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">8. Contact</h2>
            <p>
              Legal questions:{' '}
              <a
                href="mailto:legal@loopfinance.io"
                className="text-blue-600 underline hover:text-blue-800 dark:text-blue-400"
              >
                legal@loopfinance.io
              </a>
              . General contact:{' '}
              <a
                href="mailto:hello@loopfinance.io"
                className="text-blue-600 underline hover:text-blue-800 dark:text-blue-400"
              >
                hello@loopfinance.io
              </a>
              .
            </p>
          </section>
        </article>

        <section className="mt-12 flex gap-6 text-sm">
          <Link
            to="/privacy"
            className="text-blue-600 underline hover:text-blue-800 dark:text-blue-400"
          >
            Privacy Policy
          </Link>
          <Link
            to="/"
            className="text-gray-600 underline hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Back to home
          </Link>
        </section>
      </main>
      <Footer />
    </>
  );
}
