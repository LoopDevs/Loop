/**
 * Transactional email — currently just the OTP send (ADR 013). Kept
 * behind a narrow interface so the concrete provider (Resend /
 * Postmark / SES) can be swapped without touching handlers.
 *
 * The dev default is `console` — it writes the code to stdout so
 * `npm run dev:backend` works end-to-end without SMTP credentials.
 * Production deploys set `EMAIL_PROVIDER=<real>` and the relevant
 * API key env vars (not yet implemented — landing with the first
 * real provider PR).
 */
import { logger } from '../logger.js';
import { env } from '../env.js';

const log = logger.child({ area: 'email' });

export interface OtpEmailInput {
  to: string;
  code: string;
  expiresAt: Date;
}

export interface EmailProvider {
  readonly name: string;
  sendOtpEmail(input: OtpEmailInput): Promise<void>;
}

/**
 * Dev-only provider: logs the code to stdout instead of sending.
 * Intentionally writes at `info` so it's visible in default LOG_LEVEL.
 * This provider must never be selected in production (see
 * `getEmailProvider`).
 *
 * A2-1612: Pino redacts `code` via `REDACT_PATHS`, but if
 * `@sentry/pino` is configured the Sentry transport receives the log
 * record BEFORE the redaction pass applies. Guard by skipping the
 * raw-code payload when `SENTRY_DSN` is set — devs running local
 * Sentry read the code from the DB row (`auth_otps`) or the API's
 * test-only verify-otp response rather than through the log.
 */
class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';

  async sendOtpEmail(input: OtpEmailInput): Promise<void> {
    const sentryActive = env.SENTRY_DSN !== undefined;
    log.info(
      {
        to: input.to,
        // Redact when Sentry is active so the raw code can't land in
        // a Sentry breadcrumb. Fall through to full code in the
        // default (no-Sentry) dev loop so the console stub still
        // serves its "grab the OTP from the log" purpose.
        ...(sentryActive ? { code: '[REDACTED: SENTRY_DSN set]' } : { code: input.code }),
        expiresAt: input.expiresAt.toISOString(),
      },
      sentryActive
        ? 'OTP email (console stub) — code redacted because SENTRY_DSN is set; read from DB'
        : 'OTP email (console stub) — this provider is dev-only',
    );
  }
}

let cached: EmailProvider | null = null;

/**
 * Lazily constructs the configured provider. The choice is driven by
 * `EMAIL_PROVIDER` when set; absent, it's `console` in non-production
 * and a throw in production (deploying to prod without real email is
 * a loud failure, not a silent one).
 */
export function getEmailProvider(): EmailProvider {
  if (cached !== null) return cached;
  const configured = process.env['EMAIL_PROVIDER'];
  if (configured === undefined || configured === 'console') {
    // A2-571: the console provider logs plaintext OTPs to stdout and
    // MUST NEVER run in production — regardless of whether it's the
    // unset default or an explicit `EMAIL_PROVIDER=console`. A prior
    // version only rejected the unset case; a deploy that shipped
    // `EMAIL_PROVIDER=console` would silently leak OTPs into
    // production logs. Reject both shapes loudly.
    if (env.NODE_ENV === 'production') {
      throw new Error(
        `EMAIL_PROVIDER=${configured ?? '<unset>'} is not permitted in production — the console stub logs plaintext OTPs`,
      );
    }
    cached = new ConsoleEmailProvider();
    return cached;
  }
  // Future providers land here. Keeping the throw minimal so an
  // operator setting EMAIL_PROVIDER to an unknown value doesn't
  // silently fall back to the console stub (which would leak OTP
  // codes to stdout in production).
  throw new Error(`Unsupported EMAIL_PROVIDER: ${configured}`);
}

/** Resets the cached provider — test-only. */
export function __resetEmailProviderForTests(): void {
  cached = null;
}
