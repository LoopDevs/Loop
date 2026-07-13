import { z } from 'zod';
import { Keypair } from '@stellar/stellar-sdk';
import { DEFAULT_CLIENT_IDS } from '@loop/shared';
import { CANONICAL_MAINNET_USDC_ISSUER, MAINNET_NETWORK_PASSPHRASE } from './env/schema-helpers.js';
import { coreEnvFields } from './env/sections/core.js';
import { authEnvFields } from './env/sections/auth.js';
import { infraEnvFields } from './env/sections/infra.js';

// Re-exported so existing importers (e.g. env.test.ts) keep resolving
// after the D2 split moved the const into env/schema-helpers.ts.
export { CANONICAL_MAINNET_USDC_ISSUER } from './env/schema-helpers.js';

// CFG-05: the recognised Stellar network passphrases. The schema for
// LOOP_STELLAR_NETWORK_PASSPHRASE deliberately accepts any non-empty
// string (a self-hosted network sets its own), so this set powers a
// boot WARN — not a reject — when the value is neither pubnet, testnet,
// nor futurenet, catching a typo that would silently point the payout
// signer + payment watcher at the wrong network.
const KNOWN_STELLAR_NETWORK_PASSPHRASES = new Set<string>([
  MAINNET_NETWORK_PASSPHRASE, // pubnet: 'Public Global Stellar Network ; September 2015'
  'Test SDF Network ; September 2015', // testnet
  'Test SDF Future Network ; October 2022', // futurenet
]);

/**
 * Environment schema. Exported so tests can exercise it directly if they
 * ever need to (today they go through `parseEnv` instead); production
 * code should consume the validated `env` object at the bottom of this
 * file, not the raw schema.
 */
export const EnvSchema = z.object({
  ...coreEnvFields,
  ...authEnvFields,
  ...infraEnvFields,
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parses a raw env source against `EnvSchema`. Returns the validated env or
 * throws with a descriptive message that includes each failing field's reason
 * (not just the path), so ops can tell the difference between "missing" and
 * "present but invalid URL". Exported so tests can exercise the schema
 * without relying on mutating `process.env`.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment variables — ${details}`);
  }

  // Warn on footguns that pass schema validation but are almost certainly
  // misconfigurations in production. A warn (not a throw) keeps emergency
  // admin overrides possible.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.INCLUDE_DISABLED_MERCHANTS) {
    // eslint-disable-next-line no-console
    console.warn(
      '[env] INCLUDE_DISABLED_MERCHANTS=true in production — disabled merchants will be visible to end users',
    );
  }

  // CFG-02: the admin daily money caps (per-admin, per-currency, per
  // UTC day) bound how much a stolen admin session can drain via many
  // sub-per-request-cap writes. `0` DISABLES the cap entirely — a
  // documented dev/test escape hatch — so a fat-finger `0` in
  // production silently removes the treasury safeguard while everything
  // still looks healthy. Warn loudly in production (matching the
  // INCLUDE_DISABLED_MERCHANTS prod-warn) so the disabled cap is
  // visible; dev/test keep the 0=disable hatch quietly. A warn (not a
  // throw) preserves the documented "0 disables" contract for a
  // deliberate operator while removing the SILENCE the footgun relied on.
  if (parsed.data.NODE_ENV === 'production') {
    const dailyCaps: ReadonlyArray<readonly [string, bigint]> = [
      ['ADMIN_DAILY_ADJUSTMENT_CAP_MINOR', parsed.data.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR],
      ['ADMIN_DAILY_WITHDRAWAL_CAP_MINOR', parsed.data.ADMIN_DAILY_WITHDRAWAL_CAP_MINOR],
    ];
    for (const [name, value] of dailyCaps) {
      if (value === 0n) {
        // eslint-disable-next-line no-console
        console.warn(
          `[env] ${name}=0 in production DISABLES the per-admin daily cap — a stolen admin ` +
            `session can drain the treasury via many sub-per-request-cap writes inside the token ` +
            `TTL. Set a positive minor-unit cap unless this is a deliberate, temporary override.`,
        );
      }
    }
  }

  // Hardening B7 (2026-07 plan): HS256 retirement tripwire. After the
  // RS256 cutover (ADR 030 Phase A) the HS256 key must stay set only
  // for the 30-day refresh window so outstanding HS256 tokens keep
  // verifying — then it MUST be removed: every extra day it stays set
  // is a standing forgery-if-leaked surface running alongside the RSA
  // key for no benefit. Nothing else ever prompts the removal, so
  // this warn fires on every boot while both are set (deploys are the
  // natural cadence for the reminder). Runbook:
  // docs/runbooks/jwt-key-rotation.md.
  if (
    parsed.data.LOOP_JWT_RSA_PRIVATE_KEY !== undefined &&
    parsed.data.LOOP_JWT_SIGNING_KEY !== undefined
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      '[env] Both LOOP_JWT_RSA_PRIVATE_KEY and LOOP_JWT_SIGNING_KEY are set. If the RS256 cutover ' +
        'is more than 30 days old (the refresh-token TTL), remove LOOP_JWT_SIGNING_KEY — outstanding ' +
        'HS256 tokens have all expired and the key is now a pure forgery-if-leaked surface ' +
        '(docs/runbooks/jwt-key-rotation.md, hardening B7).',
    );
  }

  // Audit A-018: operators can override client IDs per environment, but
  // the web bundle hardcodes `DEFAULT_CLIENT_IDS` (via @loop/shared) at
  // build time. Warn when the effective server value diverges from that
  // default so the operator knows to rebuild the web app with matching
  // values, or the client-id allowlist in `requireAuth()` will reject
  // authenticated requests after login.
  const divergentClientIds: Array<[string, string, string]> = [];
  if (parsed.data.CTX_CLIENT_ID_WEB !== DEFAULT_CLIENT_IDS.web) {
    divergentClientIds.push([
      'CTX_CLIENT_ID_WEB',
      parsed.data.CTX_CLIENT_ID_WEB,
      DEFAULT_CLIENT_IDS.web,
    ]);
  }
  if (parsed.data.CTX_CLIENT_ID_IOS !== DEFAULT_CLIENT_IDS.ios) {
    divergentClientIds.push([
      'CTX_CLIENT_ID_IOS',
      parsed.data.CTX_CLIENT_ID_IOS,
      DEFAULT_CLIENT_IDS.ios,
    ]);
  }
  if (parsed.data.CTX_CLIENT_ID_ANDROID !== DEFAULT_CLIENT_IDS.android) {
    divergentClientIds.push([
      'CTX_CLIENT_ID_ANDROID',
      parsed.data.CTX_CLIENT_ID_ANDROID,
      DEFAULT_CLIENT_IDS.android,
    ]);
  }
  for (const [name, actual, expected] of divergentClientIds) {
    // eslint-disable-next-line no-console
    console.warn(
      `[env] ${name}=${actual} differs from @loop/shared DEFAULT_CLIENT_IDS (${expected}). ` +
        `The web bundle sends X-Client-Id from the shared constant, so authenticated requests will ` +
        `fail the X-Client-Id allowlist (audit A-036) until apps/web is rebuilt with a matching value.`,
    );
  }

  // Launch-runbook tripwire: a typo'd LOOP_STELLAR_USDC_ISSUER once
  // shipped to production — the watcher's issuer-match guard then
  // silently ignores every legitimate USDC deposit, which presents as
  // "payments never arrive" rather than an error. On mainnet, warn
  // (don't throw — a deliberate operator may genuinely point at a
  // non-Circle asset, e.g. a private network fork) whenever the value
  // differs from Circle's canonical issuer.
  if (
    parsed.data.LOOP_STELLAR_USDC_ISSUER !== undefined &&
    parsed.data.LOOP_STELLAR_NETWORK_PASSPHRASE === MAINNET_NETWORK_PASSPHRASE &&
    parsed.data.LOOP_STELLAR_USDC_ISSUER !== CANONICAL_MAINNET_USDC_ISSUER
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      `[env] LOOP_STELLAR_USDC_ISSUER=${parsed.data.LOOP_STELLAR_USDC_ISSUER} differs from ` +
        `Circle's canonical mainnet USDC issuer (${CANONICAL_MAINNET_USDC_ISSUER}) while the ` +
        `Stellar network passphrase is mainnet. If this is a typo, the payment watcher will ` +
        `silently ignore every legitimate USDC deposit. Double-check the value before serving traffic.`,
    );
  }

  // CFG-05: LOOP_STELLAR_NETWORK_PASSPHRASE accepts any non-empty string
  // (a self-hosted network legitimately sets its own), so the schema
  // can't reject a typo. But a typo'd pubnet/testnet passphrase silently
  // points the payout signer AND the payment watcher at the wrong
  // network — every signed transaction targets a chain that will never
  // accept it, and the watcher reads a chain nobody is paying into.
  // Warn (don't throw — self-hosted is a real use case) when the value
  // isn't a recognised Stellar network passphrase.
  if (!KNOWN_STELLAR_NETWORK_PASSPHRASES.has(parsed.data.LOOP_STELLAR_NETWORK_PASSPHRASE)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[env] LOOP_STELLAR_NETWORK_PASSPHRASE=${JSON.stringify(
        parsed.data.LOOP_STELLAR_NETWORK_PASSPHRASE,
      )} is not a recognised Stellar network passphrase (pubnet / testnet / futurenet). If this ` +
        `is a self-hosted network the value is expected; if it's a typo, the payout signer and ` +
        `payment watcher are pointed at the wrong network and every signed transaction will be rejected.`,
    );
  }

  // Audit A-025: the image proxy's strongest SSRF mitigation is the
  // hostname allowlist. Without it we only have best-effort IP validation,
  // which the proxy's own source documents as TOCTOU-vulnerable to DNS
  // rebinding. Refuse to start in production unless the allowlist is set.
  // Emergency opt-out is DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=1.
  //
  // A2-654: the override used to be read directly from `source[...]`
  // (i.e. process.env), bypassing the zod schema. A typo on deploy
  // left the override silently inactive. It's now a schema field
  // whose only accepted value is `"1"`; any other non-empty value
  // fails at parse time with a clear message.
  if (
    parsed.data.NODE_ENV === 'production' &&
    (parsed.data.IMAGE_PROXY_ALLOWED_HOSTS === undefined ||
      parsed.data.IMAGE_PROXY_ALLOWED_HOSTS.trim() === '') &&
    parsed.data.DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT !== '1'
  ) {
    throw new Error(
      'Invalid environment variables — IMAGE_PROXY_ALLOWED_HOSTS must be set in production (audit A-025). ' +
        'Set it to a comma-separated list of upstream image hostnames (e.g. "cdn.ctx.com,ctx-spend.s3.us-west-2.amazonaws.com"), ' +
        'or set DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=1 to override for an emergency push.',
    );
  }

  // A2-1605: DISABLE_RATE_LIMITING bypasses every per-IP rate
  // limiter in the middleware stack. That's a test-harness flag —
  // shipped to production it opens every auth/payment/admin route
  // to volumetric abuse, and the breakers downstream are not a
  // substitute (they trip on upstream failure, not request volume).
  //
  // Refuse to boot in production if the flag is set. No override —
  // if an operator truly needs a prod rate-limit bypass they can
  // edit this check out and redeploy, which is a harder foot-gun
  // than a silently-honoured env var.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.DISABLE_RATE_LIMITING) {
    throw new Error(
      'Invalid environment variables — DISABLE_RATE_LIMITING must not be set in production (audit A2-1605). ' +
        'The flag is a test-harness escape hatch; production runs without it. ' +
        'Unset the variable and redeploy.',
    );
  }

  // AUDIT-2-E: LOOP_TEST_ENDPOINTS_SECRET only has meaning alongside
  // `NODE_ENV==='test'` (it gates the test-only `/__test__/*` mount in
  // `test-endpoints.ts`, notably the zero-credential-check session
  // minter). `test-endpoints.ts` already re-checks `NODE_ENV==='test'`
  // itself before honouring the secret, so this can't by itself expose
  // the surface in production — but the secret has no business being
  // *present* in a production env at all, and refusing to boot with it
  // set catches a copy-pasted env file before it becomes a standing
  // leaked-secret risk sitting next to real production secrets.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.LOOP_TEST_ENDPOINTS_SECRET) {
    throw new Error(
      'Invalid environment variables — LOOP_TEST_ENDPOINTS_SECRET must not be set in production (AUDIT-2-E). ' +
        'It only unlocks the test-only /__test__/* endpoints; unset it and redeploy.',
    );
  }

  // ADR 030 Phase B cross-field requirement: selecting the Privy
  // wallet provider without its credentials would otherwise only
  // surface on the first wallet call (as a terminal provider error).
  // Fail at boot instead, naming exactly what's missing.
  if (parsed.data.LOOP_WALLET_PROVIDER === 'privy') {
    const missing: string[] = [];
    if (parsed.data.PRIVY_APP_ID === undefined) missing.push('PRIVY_APP_ID');
    if (parsed.data.PRIVY_APP_SECRET === undefined) missing.push('PRIVY_APP_SECRET');
    if (missing.length > 0) {
      throw new Error(
        `Invalid environment variables — LOOP_WALLET_PROVIDER=privy requires ${missing.join(
          ' and ',
        )} to be set (ADR 030). Unset LOOP_WALLET_PROVIDER to disable the wallet layer instead.`,
      );
    }
  }

  // ADR 031 §Detailed design D9, V2 cross-field requirement: the vault
  // subsystem flag without a Soroban RPC endpoint would only surface
  // as a terminal error on the first deposit/withdraw call. Fail at
  // boot instead — mirrors the LOOP_WALLET_PROVIDER=privy check above.
  if (parsed.data.LOOP_VAULTS_ENABLED && parsed.data.LOOP_SOROBAN_RPC_URL === undefined) {
    throw new Error(
      'Invalid environment variables — LOOP_VAULTS_ENABLED=true requires LOOP_SOROBAN_RPC_URL to be ' +
        'set (ADR 031). Unset LOOP_VAULTS_ENABLED to keep the vault subsystem dark instead.',
    );
  }

  // ADR 031 V3 (money-review #1647 P2-4): the vault-emission SWEEP —
  // the only thing that drains a claimed `vault_emissions` row through
  // deposit → transfer → mirror — runs ONLY under LOOP_WORKERS_ENABLED
  // (index.ts). With vaults on but workers off, `orders/fulfillment.ts`
  // would claim a `vault_emissions` row and NOTHING would ever advance
  // it: the user gets neither an on-chain emission NOR a mirror credit.
  // Fail boot in production (mirrors the LOOP_ADMIN_STEP_UP /
  // LOOP_STELLAR_USDC_ISSUER precedent for "runtime-worker-dependent
  // config that only bites a live deployment" — NOT the unconditional
  // LOOP_WALLET_PROVIDER=privy config-completeness shape). Scoped to
  // production so tests/dev can enable vaults to drive the sweep
  // directly (the integration suite does exactly this); staging runs
  // NODE_ENV=production, so it's covered too.
  if (
    parsed.data.NODE_ENV === 'production' &&
    parsed.data.LOOP_VAULTS_ENABLED &&
    !parsed.data.LOOP_WORKERS_ENABLED
  ) {
    throw new Error(
      'Invalid environment variables — LOOP_VAULTS_ENABLED=true requires LOOP_WORKERS_ENABLED=true in ' +
        'production (ADR 031 V3): the vault-emission sweep that drains claimed vault_emissions rows only ' +
        'runs under LOOP_WORKERS_ENABLED, so vaults-on/workers-off would strand every vault cashback ' +
        '(no on-chain emission AND no mirror credit). Enable the workers or unset LOOP_VAULTS_ENABLED.',
    );
  }

  // ADR 031 / ADR 036 Phase D: issuer-secret ↔ issuer-address pinning.
  // A `LOOP_STELLAR_<ASSET>_ISSUER_SECRET` whose derived public key
  // doesn't match the configured `LOOP_STELLAR_<ASSET>_ISSUER` would
  // make the payout worker sign `interest_mint` payments from a
  // different account — a transfer rather than a mint, corrupting
  // issuance accounting silently. Boot-fail on mismatch (and on a
  // secret with no address to validate against) rather than
  // discovering it on the first nightly mint.
  const issuerPairs: Array<[string, string | undefined, string | undefined]> = [
    [
      'USDLOOP',
      parsed.data.LOOP_STELLAR_USDLOOP_ISSUER,
      parsed.data.LOOP_STELLAR_USDLOOP_ISSUER_SECRET,
    ],
    [
      'GBPLOOP',
      parsed.data.LOOP_STELLAR_GBPLOOP_ISSUER,
      parsed.data.LOOP_STELLAR_GBPLOOP_ISSUER_SECRET,
    ],
    [
      'EURLOOP',
      parsed.data.LOOP_STELLAR_EURLOOP_ISSUER,
      parsed.data.LOOP_STELLAR_EURLOOP_ISSUER_SECRET,
    ],
  ];
  for (const [asset, issuerAddress, issuerSecret] of issuerPairs) {
    if (issuerSecret === undefined) continue;
    if (issuerAddress === undefined) {
      throw new Error(
        `Invalid environment variables — LOOP_STELLAR_${asset}_ISSUER_SECRET is set but ` +
          `LOOP_STELLAR_${asset}_ISSUER is not (ADR 031). The secret must be validated against the ` +
          `configured issuer address; set both or neither.`,
      );
    }
    let derived: string;
    try {
      derived = Keypair.fromSecret(issuerSecret).publicKey();
    } catch {
      throw new Error(
        `Invalid environment variables — LOOP_STELLAR_${asset}_ISSUER_SECRET is not a valid ` +
          `Stellar secret key (Keypair derivation failed).`,
      );
    }
    if (derived !== issuerAddress) {
      throw new Error(
        `Invalid environment variables — LOOP_STELLAR_${asset}_ISSUER_SECRET derives account ` +
          `${derived}, which does not match LOOP_STELLAR_${asset}_ISSUER (${issuerAddress}). ` +
          `Signing interest mints with a non-issuer key would transfer instead of mint (ADR 031); ` +
          `fix the key material before booting.`,
      );
    }
  }

  // ADR 044 / S4-1: payout channel accounts must each be well-formed
  // (the schema regex above already covers gross format), mutually
  // distinct, and distinct from the operator + every configured
  // issuer account. A channel that collides with any of those would
  // silently reintroduce the exact sequence-number race channels
  // exist to eliminate — two submitters (the channel-as-itself path
  // and the direct operator/issuer path, or two duplicated channel
  // entries) fighting over the same account's sequence number.
  if (parsed.data.LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS !== undefined) {
    // Best-effort: the operator/issuer secrets are used here only to
    // detect a COLLISION with a channel entry, not to (re-)validate
    // their own checksum — that's not this block's job, and today a
    // checksum-invalid-but-regex-matching operator/issuer secret
    // already boots fine (it fails gracefully at first use — e.g.
    // `resolvePayoutConfig` logs and disables the payout worker rather
    // than throwing). A derivation failure here just means "no
    // collision to check against"; it must not turn into a NEW boot
    // failure as a side effect of adding channel-account validation.
    const reservedAccounts = new Map<string, string>(); // account -> owning env var label
    const tryReserve = (secret: string, label: string): void => {
      try {
        reservedAccounts.set(Keypair.fromSecret(secret).publicKey(), label);
      } catch {
        // Undecodable — leave it out of the collision set; whatever
        // consumes this secret at runtime surfaces the real problem.
      }
    };
    if (parsed.data.LOOP_STELLAR_OPERATOR_SECRET !== undefined) {
      tryReserve(parsed.data.LOOP_STELLAR_OPERATOR_SECRET, 'LOOP_STELLAR_OPERATOR_SECRET');
    }
    for (const [asset, , issuerSecret] of issuerPairs) {
      if (issuerSecret === undefined) continue;
      tryReserve(issuerSecret, `LOOP_STELLAR_${asset}_ISSUER_SECRET`);
    }
    const channelSecrets = parsed.data.LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const seenChannelAccounts = new Map<string, number>(); // account -> first 1-based index
    channelSecrets.forEach((secret, i) => {
      const index = i + 1;
      // Unlike the collision lookups above, a channel entry's OWN
      // checksum validity IS this block's job (mirrors the issuer-
      // secret pattern's `catch { throw ... }` for its own secret) —
      // a channel that can't derive an account can't submit anything.
      let account: string;
      try {
        account = Keypair.fromSecret(secret).publicKey();
      } catch {
        throw new Error(
          `Invalid environment variables — LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS entry ${index} ` +
            `is not a valid Stellar secret key (Keypair derivation failed).`,
        );
      }
      const collidesWith = reservedAccounts.get(account);
      if (collidesWith !== undefined) {
        throw new Error(
          `Invalid environment variables — LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS entry ${index} ` +
            `derives account ${account}, which is also ${collidesWith}. A channel account must ` +
            `be distinct from the operator and every issuer account (ADR 044) — reusing one ` +
            `reintroduces the sequence-number race channels exist to eliminate.`,
        );
      }
      const firstIndex = seenChannelAccounts.get(account);
      if (firstIndex !== undefined) {
        throw new Error(
          `Invalid environment variables — LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS entries ${firstIndex} ` +
            `and ${index} derive the same account (${account}). Each channel must be a distinct ` +
            `account (ADR 044).`,
        );
      }
      seenChannelAccounts.set(account, index);
    });
  }

  // Hardening B3 (2026-07 plan): cross-field boot guards for the two
  // auth misconfigurations that previously only surfaced at request
  // time.
  //
  // 1. Native auth enabled with NO signing capability. verify-otp /
  //    refresh would 500 on every call (`getActiveSigner` throws) —
  //    an outage discovered by the first user, not the deploy. Both
  //    key families count: HS256 (`LOOP_JWT_SIGNING_KEY`) or RS256
  //    (`LOOP_JWT_RSA_PRIVATE_KEY`).
  if (
    parsed.data.LOOP_AUTH_NATIVE_ENABLED &&
    parsed.data.LOOP_JWT_SIGNING_KEY === undefined &&
    parsed.data.LOOP_JWT_RSA_PRIVATE_KEY === undefined
  ) {
    throw new Error(
      'Invalid environment variables — LOOP_AUTH_NATIVE_ENABLED=true requires a JWT signing key ' +
        '(LOOP_JWT_SIGNING_KEY or LOOP_JWT_RSA_PRIVATE_KEY, ADR 013 / ADR 030). Without one, every ' +
        'verify-otp/refresh call 500s. Set a key or disable native auth.',
    );
  }

  // R3-7: production must not silently fall back to the legacy
  // CTX-proxy auth path. If this flag is unset on a new prod deploy,
  // a CTX outage becomes a full login outage and the Loop-owned auth
  // controls are bypassed. Fail fast unless the operator deliberately
  // ships the rollback/staging override.
  if (
    parsed.data.NODE_ENV === 'production' &&
    !parsed.data.LOOP_AUTH_NATIVE_ENABLED &&
    parsed.data.DISABLE_NATIVE_AUTH_ENFORCEMENT !== '1'
  ) {
    throw new Error(
      'Invalid environment variables — LOOP_AUTH_NATIVE_ENABLED must be true in production ' +
        '(R3-7 / ADR 013). Leaving it false reverts auth to the legacy CTX-proxy path. ' +
        'Set LOOP_AUTH_NATIVE_ENABLED=true with a JWT signing key, or set ' +
        'DISABLE_NATIVE_AUTH_ENFORCEMENT=1 only for an explicit rollback/staging deploy.',
    );
  }

  // 2. Production without the admin step-up key. Every destructive
  //    admin endpoint (credit-adjust / refunds / emissions /
  //    payout-retry / staff-role writes) would return 503
  //    STEP_UP_UNAVAILABLE — a silently-degraded admin surface that
  //    looks healthy until the first incident needs an intervention.
  //    Fail at boot; staging deploys that genuinely want the surface
  //    disabled opt out explicitly.
  if (
    parsed.data.NODE_ENV === 'production' &&
    parsed.data.LOOP_ADMIN_STEP_UP_SIGNING_KEY === undefined &&
    parsed.data.DISABLE_ADMIN_STEP_UP_ENFORCEMENT !== '1'
  ) {
    throw new Error(
      'Invalid environment variables — LOOP_ADMIN_STEP_UP_SIGNING_KEY must be set in production ' +
        '(ADR 028; hardening B3). Without it every destructive admin write 503s. Generate a 32+ char ' +
        'random secret, or set DISABLE_ADMIN_STEP_UP_ENFORCEMENT=1 to deliberately ship the surface disabled.',
    );
  }

  // 3. Production without a pinned USDC issuer (AUDIT-2 finding A).
  //    Stellar asset codes are not unique — anyone can self-issue an
  //    asset called "USDC". The payment watcher's issuer-match guard
  //    (horizon.ts: isMatchingIncomingPayment) now fails CLOSED when
  //    LOOP_STELLAR_USDC_ISSUER is unset — it matches no USDC
  //    deposit at all, rather than "any issuer" — so this can no
  //    longer be exploited into a fraudulent markOrderPaid. But a
  //    silently USDC-disabled production deploy is still a
  //    launch-readiness gap worth failing loud on (every user paying
  //    by USDC would see their order stall unpaid forever), matching
  //    the LOOP_ADMIN_STEP_UP_SIGNING_KEY precedent above. Emergency
  //    opt-out for a deliberate USDC-disabled staging/rollback
  //    deploy.
  if (
    parsed.data.NODE_ENV === 'production' &&
    parsed.data.LOOP_STELLAR_USDC_ISSUER === undefined &&
    parsed.data.DISABLE_USDC_ISSUER_ENFORCEMENT !== '1'
  ) {
    throw new Error(
      'Invalid environment variables — LOOP_STELLAR_USDC_ISSUER must be set in production ' +
        '(AUDIT-2 finding A). Without it the payment watcher matches NO USDC deposits (a safe ' +
        'fail-closed default, not a fallback to "any issuer") and every USDC order stalls unpaid. ' +
        `Set LOOP_STELLAR_USDC_ISSUER to the canonical mainnet USDC issuer ` +
        `(${CANONICAL_MAINNET_USDC_ISSUER}) or your network's real USDC issuer, or set ` +
        'DISABLE_USDC_ISSUER_ENFORCEMENT=1 to deliberately ship the USDC rail disabled.',
    );
  }

  // CFG-01 (FT-06 follow-up): the entire monitoring/alert tier —
  // asset-drift, vault-drift, circuit-breaker, stuck-sweeper, and
  // ledger-invariant pages — fans out to DISCORD_WEBHOOK_MONITORING.
  // FT-06 made `sendWebhook` return false (and warn once) when the URL
  // is unset, so an unset webhook now means every alert silently
  // delivers NOWHERE while /health stays green. Require it in
  // production so a launch can't fly blind on treasury/integrity
  // alerting — same required-in-prod shape as the image-proxy /
  // step-up / USDC-issuer guards, with the same `"1"`-only emergency
  // opt-out. Keyed on NODE_ENV OR LOOP_ENV so a staging deploy
  // (NODE_ENV=production, LOOP_ENV=staging) and an explicit
  // LOOP_ENV=production tag are both covered.
  if (
    (parsed.data.NODE_ENV === 'production' || parsed.data.LOOP_ENV === 'production') &&
    parsed.data.DISCORD_WEBHOOK_MONITORING === undefined &&
    parsed.data.DISABLE_MONITORING_WEBHOOK_ENFORCEMENT !== '1'
  ) {
    throw new Error(
      'Invalid environment variables — DISCORD_WEBHOOK_MONITORING must be set in production ' +
        '(CFG-01; FT-06 follow-up). Without it every monitoring alert (asset/vault drift, circuit ' +
        'breaker, stuck sweepers, ledger-invariant) is dropped silently while /health stays green. ' +
        'Set it to your Discord monitoring webhook, or set DISABLE_MONITORING_WEBHOOK_ENFORCEMENT=1 ' +
        'to deliberately ship without monitoring alerts.',
    );
  }

  // FT-09: EMAIL_PROVIDER=resend selected without RESEND_API_KEY. The
  // OTP send path (`getEmailProvider`) throws "EMAIL_PROVIDER=resend
  // requires RESEND_API_KEY", but `nativeRequestOtpHandler` swallows
  // that throw into a generic 200 (A4-002 enumeration defence) — so
  // every login OTP silently fails while the endpoint reports success:
  // a total, invisible login outage. Fail at boot in production instead
  // (mirrors the LOOP_WALLET_PROVIDER=privy cross-field check). Scoped
  // to production: dev/test use the console stub, and a resend-without-
  // key there surfaces loudly at first use rather than in prod traffic.
  if (
    parsed.data.NODE_ENV === 'production' &&
    parsed.data.EMAIL_PROVIDER === 'resend' &&
    (parsed.data.RESEND_API_KEY === undefined || parsed.data.RESEND_API_KEY === '')
  ) {
    throw new Error(
      'Invalid environment variables — EMAIL_PROVIDER=resend requires RESEND_API_KEY in ' +
        'production (FT-09). Without it every request-otp throws in the email provider and is ' +
        'swallowed into a fake 200 (a silent, total login outage). Set RESEND_API_KEY, or unset ' +
        'EMAIL_PROVIDER to fall back to the dev console stub.',
    );
  }

  // A2-203: the fallback cashback split must respect the
  // `userCashback + margin + wholesale = 100` invariant. Reject a
  // misconfigured env at boot rather than silently over-granting
  // cashback at order-creation time.
  const userCashback = Number.parseFloat(parsed.data.DEFAULT_USER_CASHBACK_PCT_OF_CTX);
  const loopMargin = Number.parseFloat(parsed.data.DEFAULT_LOOP_MARGIN_PCT_OF_CTX);
  if (userCashback + loopMargin > 100) {
    throw new Error(
      `Invalid environment variables — DEFAULT_USER_CASHBACK_PCT_OF_CTX (${userCashback}%) ` +
        `+ DEFAULT_LOOP_MARGIN_PCT_OF_CTX (${loopMargin}%) exceeds 100% of face value. ` +
        `Wholesale (what Loop pays CTX) would go negative.`,
    );
  }

  // CF-25 / X-PRIV-03: validate the redeem envelope key decodes to
  // exactly 32 bytes when present. A wrong-length key would silently
  // write ciphertext nobody can later decrypt (the read path throws on
  // every order), so fail at boot instead. Optional → no constraint.
  if (
    parsed.data.LOOP_REDEEM_ENCRYPTION_KEY !== undefined &&
    parsed.data.LOOP_REDEEM_ENCRYPTION_KEY !== ''
  ) {
    const raw = parsed.data.LOOP_REDEEM_ENCRYPTION_KEY;
    const bytes = /^[0-9a-fA-F]{64}$/.test(raw)
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');
    if (bytes.length !== 32) {
      throw new Error(
        `Invalid environment variables — LOOP_REDEEM_ENCRYPTION_KEY must decode to 32 bytes ` +
          `(got ${bytes.length}); supply 32 random bytes as base64 or hex ` +
          `(e.g. \`openssl rand -base64 32\`).`,
      );
    }
  }

  return parsed.data;
}

/** Validated, typed environment configuration. */
export const env = parseEnv(process.env);
