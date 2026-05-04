/**
 * Transactional email — currently just the OTP send (ADR 013). Kept
 * behind a narrow interface so the concrete provider (Resend /
 * Postmark / SES) can be swapped without touching handlers.
 *
 * The dev default is `console` — it writes the code to stdout so
 * `npm run dev:backend` works end-to-end without SMTP credentials.
 * Production deploys set `EMAIL_PROVIDER=resend` (or another real
 * provider) plus the matching API-key env var. The `resend`
 * implementation lives below.
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

/**
 * Resend transactional-email provider. Posts the OTP body to
 * `https://api.resend.com/emails` with the operator's
 * `RESEND_API_KEY`.
 *
 * Two operator-tunable env vars beyond the API key:
 *   - `EMAIL_FROM_ADDRESS` — the sender. Resend requires this
 *     domain to be verified (DKIM / SPF) in their dashboard
 *     before delivery succeeds. Defaults to `noreply@loopfinance.io`
 *     to make the launch path the no-touch case.
 *   - `EMAIL_FROM_NAME` — the human-readable display name.
 *     Defaults to `Loop`.
 *
 * Network failure / non-2xx responses throw — the caller (OTP
 * handler) maps the throw to a 503 so the user retries rather than
 * silently submitting a code that was never sent.
 */
class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async sendOtpEmail(input: OtpEmailInput): Promise<void> {
    const subject = `Your Loop verification code: ${input.code}`;
    const expiresAtIso = input.expiresAt.toISOString();
    const minutes = Math.max(1, Math.round((input.expiresAt.getTime() - Date.now()) / 60_000));
    const text = [
      `Your Loop verification code is ${input.code}`,
      '',
      `Enter this code to sign in. It expires in ${minutes} minutes (${expiresAtIso}).`,
      '',
      "If you didn't request this, you can ignore this email.",
    ].join('\n');
    const html = [
      `<p>Your Loop verification code is</p>`,
      `<p style="font-size:24px;font-weight:700;letter-spacing:0.1em;">${escapeHtml(input.code)}</p>`,
      `<p>Enter this code to sign in. It expires in ${minutes} minutes.</p>`,
      `<p style="color:#888;font-size:12px;">If you didn't request this, you can ignore this email.</p>`,
    ].join('');

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: this.from,
        to: input.to,
        subject,
        text,
        html,
      }),
      // 10s — short enough that a hung Resend doesn't lock up the
      // OTP request beyond what the user would tolerate; the OTP
      // handler's circuit / retry plumbing covers transient blips
      // on the next attempt.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await safeReadBody(res);
      log.error(
        { status: res.status, to: input.to, body: body.slice(0, 300) },
        'Resend email send failed',
      );
      throw new Error(`Resend ${res.status} on /emails`);
    }
  }
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  if (configured === 'resend') {
    const apiKey = process.env['RESEND_API_KEY'];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('EMAIL_PROVIDER=resend requires RESEND_API_KEY to be set');
    }
    const fromAddress = process.env['EMAIL_FROM_ADDRESS'] ?? 'noreply@loopfinance.io';
    const fromName = process.env['EMAIL_FROM_NAME'] ?? 'Loop';
    cached = new ResendEmailProvider(apiKey, `${fromName} <${fromAddress}>`);
    return cached;
  }
  // Keeping the throw minimal so an operator setting
  // EMAIL_PROVIDER to an unknown value doesn't silently fall back
  // to the console stub (which would leak OTP codes to stdout in
  // production).
  throw new Error(`Unsupported EMAIL_PROVIDER: ${configured}`);
}

/** Resets the cached provider — test-only. */
export function __resetEmailProviderForTests(): void {
  cached = null;
}
