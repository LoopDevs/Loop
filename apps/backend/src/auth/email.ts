// transactional email — ADR 013
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { logger } from '../logger.js';
import { config } from '../config/index.js';

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

// A2-1612: Sentry transport receives log records before redaction; skip raw code when SENTRY_DSN is set
class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';

  async sendOtpEmail(input: OtpEmailInput): Promise<void> {
    const sentryActive = config.observability.sentry.dsn !== undefined;
    log.info(
      {
        to: input.to,
        // Key is not `code`/`otp` — REDACT_PATHS censors those even in dev
        ...(sentryActive
          ? { code: '[REDACTED: SENTRY_DSN set]' }
          : { revealedDevOtpCode: input.code }),
        expiresAt: input.expiresAt.toISOString(),
      },
      sentryActive
        ? 'OTP email (console stub) — code redacted because a Sentry DSN is set; read from DB'
        : 'OTP email (console stub) — this provider is dev-only',
    );
  }
}

class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly replyTo: string | null,
  ) {}

  async sendOtpEmail(input: OtpEmailInput): Promise<void> {
    const { subject, text, html } = renderOtpEmail(input);

    // Omit reply_to when unset — sending null confuses some inbox clients
    const body: Record<string, unknown> = {
      from: this.from,
      to: input.to,
      subject,
      text,
      html,
    };
    if (this.replyTo !== null) {
      body['reply_to'] = this.replyTo;
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
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

class AwsSesEmailProvider implements EmailProvider {
  readonly name = 'aws_ses';

  private readonly client: SESv2Client;

  constructor(
    region: string,
    credentials: { accessKeyId: string; secretAccessKey: string } | undefined,
    private readonly from: string,
    private readonly replyTo: string | null,
  ) {
    this.client = new SESv2Client({
      region,
      requestHandler: { requestTimeout: 10_000 },
      ...(credentials !== undefined ? { credentials } : {}),
    });
  }

  async sendOtpEmail(input: OtpEmailInput): Promise<void> {
    const { subject, text, html } = renderOtpEmail(input);
    try {
      await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.from,
          Destination: { ToAddresses: [input.to] },
          ...(this.replyTo !== null ? { ReplyToAddresses: [this.replyTo] } : {}),
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: text, Charset: 'UTF-8' },
                Html: { Data: html, Charset: 'UTF-8' },
              },
            },
          },
        }),
      );
    } catch (err) {
      const name = err instanceof Error ? err.name : 'unknown';
      log.error({ to: input.to, errorName: name }, 'SES email send failed');
      throw new Error(`SES SendEmail failed (${name})`, { cause: err });
    }
  }
}

// NTF-18: OTP code must not appear in subject line (visible in lock-screen previews)
function renderOtpEmail(input: OtpEmailInput): { subject: string; text: string; html: string } {
  const subject = 'Your Loop verification code';
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
  return { subject, text, html };
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

export function getEmailProvider(): EmailProvider {
  if (cached !== null) return cached;
  const email = config.email;
  switch (email.provider) {
    case 'console': {
      // A2-571: console provider logs plaintext OTPs; A4-093 covers native-auth-on case
      if (config.env === 'production') {
        throw new Error(
          'email.provider=console is not permitted in production — the console stub logs plaintext OTPs',
        );
      }
      cached = new ConsoleEmailProvider();
      break;
    }
    case 'resend': {
      const from = `${email.from.name} <${email.from.address}>`;
      cached = new ResendEmailProvider(email.credentials.key, from, email.replyTo ?? null);
      break;
    }
    case 'aws_ses': {
      const from = `${email.from.name} <${email.from.address}>`;
      const credentials =
        email.credentials !== undefined
          ? { accessKeyId: email.credentials.key, secretAccessKey: email.credentials.secret }
          : undefined;
      cached = new AwsSesEmailProvider(email.region, credentials, from, email.replyTo ?? null);
      break;
    }
  }
  return cached;
}

export function __resetEmailProviderForTests(): void {
  cached = null;
}
