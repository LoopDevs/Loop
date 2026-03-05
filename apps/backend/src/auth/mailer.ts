import nodemailer from 'nodemailer';
import { env } from '../env.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'mailer' });

const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  auth:
    env.SMTP_USER && env.SMTP_PASS
      ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
      : undefined,
});

/** Sends a 6-digit OTP to the given email address. */
export async function sendOtpEmail(email: string, otp: string): Promise<void> {
  if (!env.SMTP_HOST) {
    // Development fallback: log the OTP instead of sending
    log.info({ otp }, 'OTP (no SMTP configured — printed to log)');
    return;
  }

  await transporter.sendMail({
    from: env.EMAIL_FROM,
    to: email,
    subject: 'Your Loop verification code',
    text: `Your Loop verification code is: ${otp}\n\nThis code expires in 10 minutes.`,
    html: `
      <p>Your Loop verification code is:</p>
      <h1 style="letter-spacing:0.25em">${otp}</h1>
      <p>This code expires in 10 minutes.</p>
    `,
  });

  log.info('OTP email sent');
}
