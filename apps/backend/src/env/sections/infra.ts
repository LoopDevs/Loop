/**
 * env section (hardening D2 split): a field-map spread into the
 * composed `EnvSchema` in `../../env.ts`. Add new vars for this
 * domain HERE — keeps `env.ts` from being a merge-conflict magnet.
 */
import { z } from 'zod';

export const infraEnvFields = {
  // Transactional email provider (ADR 013). When unset / `console`
  // the dev-only stub fires; production refuses to start with the
  // console value (see auth/email.ts). Add a real provider before
  // flipping `LOOP_AUTH_NATIVE_ENABLED=true` in production.
  // Currently supported: `resend`. Each provider has its own
  // API-key + from-address envs.
  EMAIL_PROVIDER: z.enum(['console', 'resend']).optional(),

  // Resend API key (https://resend.com). Required when
  // EMAIL_PROVIDER=resend. Format is `re_...` — never log this.
  RESEND_API_KEY: z.string().optional(),

  // Sender address used by the email provider. Must be a domain
  // the operator has verified DKIM/SPF for at the provider's
  // dashboard. Defaults to `noreply@loopfinance.io` if unset.
  EMAIL_FROM_ADDRESS: z.string().email().optional(),

  // Display name for the From header. Defaults to `Loop`.
  EMAIL_FROM_NAME: z.string().optional(),

  // Optional Reply-To address for transactional email. When set, OTP
  // emails carry a `reply_to` header so user replies route to a
  // monitored inbox instead of bouncing off the no-reply sender.
  // Unset → the reply_to key is omitted from the provider payload.
  //
  // Declared in the schema so a typo'd address fails parseEnv at boot;
  // the call site still reads process.env live, matching the
  // documented test-reload pattern used by the sibling EMAIL_* vars.
  EMAIL_REPLY_TO_ADDRESS: z.string().email().optional(),

  // ADR 052: chain-qualified CTX payment currencies Loop offers at
  // checkout, comma-separated (e.g. "XLM,DASH,ETH.USDT"). The
  // customer pays CTX directly in one of these; CTX validates the
  // final say per company crypto permissions. Unset → XLM only.
  LOOP_CTX_PAYMENT_CURRENCIES: z.string().min(1).optional(),

  // CF-26 / X-PRIV-07/08: auth-row retention purge. Always-on
  // periodic sweep that deletes expired/consumed OTP rows and dead
  // (expired or long-revoked) refresh-token rows past the retention
  // grace. Both tables hold PII (email / token hash) with no lawful
  // basis to retain dead rows. Hourly by default — retention hygiene
  // is not latency-sensitive. The retention window defaults to 30
  // days, comfortably past the refresh horizon so a live session is
  // never reaped.
  LOOP_AUTH_ROW_PURGE_INTERVAL_HOURS: z.coerce.number().int().positive().default(1),
  LOOP_AUTH_ROW_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
};
