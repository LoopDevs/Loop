import { Link } from 'react-router';
import type { Route } from './+types/privacy';
import { Navbar } from '~/components/features/Navbar';
import { Footer } from '~/components/features/Footer';

/**
 * `/privacy` — privacy policy placeholder (#662).
 *
 * App Store + Play Store submission gates on the presence of a
 * privacy policy URL on the canonical web domain (roadmap Phase
 * 1 mobile-submission checklist). This page ships the structural
 * shell — route, URL, SSR meta — so the store listings can
 * already point at `https://loopfinance.io/privacy`. The legal
 * copy is a placeholder flagged clearly as "pending review";
 * counsel will drop in the final text before submission.
 *
 * Sections mirror the GDPR / CCPA / App Store disclosure outline
 * so the final copy can be slotted in per-section rather than
 * re-architecting the page. Don't use the placeholder text in
 * any binding context.
 */
export function meta(): Route.MetaDescriptors {
  return [
    { title: 'Privacy Policy — Loop' },
    {
      name: 'description',
      content: 'How Loop handles your personal data.',
    },
    { tagName: 'link', rel: 'canonical', href: 'https://loopfinance.io/privacy' },
  ];
}

export default function PrivacyRoute(): React.JSX.Element {
  return (
    <>
      <Navbar />
      <main className="container mx-auto max-w-3xl px-4 py-12">
        <header className="mb-10">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">Privacy Policy</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Last updated: pending publication
          </p>
        </header>

        <aside
          role="note"
          className="mb-10 rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-900 dark:border-yellow-900/60 dark:bg-yellow-900/20 dark:text-yellow-200"
        >
          This privacy policy is a placeholder pending final legal review. The structural outline
          below reflects the categories of data Loop collects; precise language will be finalised
          before the App Store / Play Store listings go live. Questions:{' '}
          <a href="mailto:privacy@loopfinance.io" className="underline hover:no-underline">
            privacy@loopfinance.io
          </a>
          .
        </aside>

        <article className="prose prose-gray max-w-none dark:prose-invert text-gray-700 dark:text-gray-300 space-y-6">
          <section>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              1. What we collect
            </h2>
            <p>
              Account identifiers (email address), authentication metadata (device identifiers for
              OTP delivery), purchase history (orders you place through Loop), and on-chain activity
              tied to wallet addresses you explicitly link to your account.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              2. How we use it
            </h2>
            <p>
              Fulfilling gift-card orders, paying out cashback to the wallet address you configure,
              sending transactional and security-related email, and meeting legal / regulatory
              obligations (KYC / AML where applicable to Stellar payouts).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              3. Who we share it with
            </h2>
            <p>
              Our upstream gift-card supplier (CTX — required to procure the card you ordered), our
              email provider (transactional delivery only), and regulators / law enforcement where
              legally required. We do not sell your data.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              4. How long we keep it
            </h2>
            <p>
              Order and credit-ledger data are retained for the duration required by accounting and
              regulatory rules in your home jurisdiction. Account identifiers are deleted within 30
              days of account closure unless retention is mandated by law.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">5. Your rights</h2>
            <p>
              Access, rectification, erasure, portability, and restriction of processing — subject
              to the applicable regime in your jurisdiction (UK GDPR / EU GDPR / CCPA / equivalent).
              Requests:{' '}
              <a
                href="mailto:privacy@loopfinance.io"
                className="text-blue-600 underline hover:text-blue-800 dark:text-blue-400"
              >
                privacy@loopfinance.io
              </a>
              .
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">6. Contact</h2>
            <p>
              Data protection questions:{' '}
              <a
                href="mailto:privacy@loopfinance.io"
                className="text-blue-600 underline hover:text-blue-800 dark:text-blue-400"
              >
                privacy@loopfinance.io
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
            to="/terms"
            className="text-blue-600 underline hover:text-blue-800 dark:text-blue-400"
          >
            Terms of Service
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
