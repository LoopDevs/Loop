// config sections: `observability:` and `mobile:` — A2-1310, A2-1309, ADR 017, ADR 018, A2-2008, CF-10, A2-1606, P2-14, M-3
import { z } from 'zod';

// SEC-10: restrict to official Discord HTTPS webhook endpoints to prevent exfiltration via copy-paste errors or malicious overrides
const DISCORD_WEBHOOK_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'ptb.discord.com',
  'canary.discord.com',
  'ptb.discordapp.com',
  'canary.discordapp.com',
]);
const DISCORD_WEBHOOK_PATH = /^\/api\/(v\d+\/)?webhooks\//;
const discordWebhookUrl = z
  .string()
  .url()
  .refine(
    (raw) => {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        return false;
      }
      return (
        u.protocol === 'https:' &&
        DISCORD_WEBHOOK_HOSTS.has(u.hostname.toLowerCase()) &&
        DISCORD_WEBHOOK_PATH.test(u.pathname)
      );
    },
    {
      message:
        'must be an https Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>)',
    },
  );

export const observabilitySchema = z
  .object({
    // A2-1310: distinct from top-level `env:` to allow staging deployments to run production behavior while bucketing events as staging
    environmentTag: z.string().min(1).optional(),

    sentry: z
      .object({
        dsn: z.string().url().optional(),
        // A2-1309: set to git SHA in CI/CD to pivot events to exact deploy artifacts; keep unset locally to avoid polluting release pivot
        release: z.string().min(1).optional(),
      })
      .prefault({}),

    discord: z
      .object({
        ordersWebhook: discordWebhookUrl.optional(),
        monitoringWebhook: discordWebhookUrl.optional(),
        // ADR 017/018 — admin action trail with narrower audience than #monitoring
        adminAuditWebhook: discordWebhookUrl.optional(),
      })
      .prefault({}),

    metrics: z
      .object({
        // A2-1606: when unset, route is open in dev/test but 404s in production to prevent anonymous scraping
        bearerToken: z.string().min(16).optional(),
      })
      .prefault({}),
  })
  .prefault({});

export const mobileSchema = z
  .object({
    // P2-14: server-side source of truth for forced-update gate; raising floor is a config change, not an app-store resubmission
    minSupportedVersion: z
      .object({
        ios: z.string().min(1).optional(),
        android: z.string().min(1).optional(),
      })
      .prefault({}),

    // M-3: gates `/.well-known/*` endpoints to 404 when unset; deep linking degrades gracefully rather than causing an outage
    deepLinks: z
      .object({
        apple: z
          .object({
            teamId: z.string().min(1).optional(),
          })
          .prefault({}),
        android: z
          .object({
            // list allows debug and release keystore fingerprints to coexist during rollout
            certFingerprints: z.array(z.string().min(1)).default([]),
          })
          .prefault({}),
      })
      .prefault({}),
  })
  .prefault({});
