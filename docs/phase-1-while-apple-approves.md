# Phase 1 — what to do while Apple Developer approval lands

Apple Developer enrollment can take 3–7 days for a personal account
(longer if D-U-N-S verification is needed for an Organization
account). Most of the Phase-1 acceptance pipeline parallelises
around it. This page is the operator's checklist of what to do
**right now**, today, while waiting on the email from Apple. Each
item links to the doc that has the actual mechanics.

Once Apple approves, the only remaining work is iOS-specific:
configuring signing in Xcode, archiving, uploading to TestFlight,
adding reviewers as internal testers. That's a single afternoon's
work — every other prerequisite below is upstream of it.

The work is grouped into three tracks. Tracks A and B are
independent and can run in parallel; Track C depends on A.

---

## Track A — Backend redeploy (~half day, ops)

The Fly app `loopfinance-api` is healthy but on the 2026-04-20
binary, which predates the entire Tranche-1 surface. The redeploy
is gated on operator-side secrets that need to be in place first.

### A.1 Set Fly secrets (10 min)

Required Tranche-1 secrets for the redeploy. The preflight script
(`./scripts/preflight-tranche-1.sh`) reports which are missing:

```bash
flyctl secrets set -a loopfinance-api \
  DATABASE_URL=postgres://…@…/loop \
  LOOP_JWT_SIGNING_KEY="$(openssl rand -base64 48)" \
  LOOP_STELLAR_DEPOSIT_ADDRESS=G… \
  LOOP_STELLAR_OPERATOR_SECRET=S… \
  LOOP_STELLAR_USDC_ISSUER=GA5ZSEJYB37JRC5AVCIA7VBRVRWWZBMXWXZAHYBRQHGSZHGCASCHV3VW \
  RESEND_API_KEY=re_… \
  METRICS_BEARER_TOKEN="$(openssl rand -base64 32)" \
  OPENAPI_BEARER_TOKEN="$(openssl rand -base64 32)"
```

Mechanics: `docs/tranche-1-launch.md` §"Track 1 — Backend deploy".

### A.2 Update `apps/backend/fly.toml [env]` (5 min)

The Tranche-1 boolean flags + email config typically ride in
`fly.toml [env]` rather than secrets. The preflight script's
VALUE_CHECKS layer flags drift here:

```toml
[env]
  PORT = "8080"
  NODE_ENV = "production"
  GIFT_CARD_API_BASE_URL = "https://spend.ctx.com"
  LOG_LEVEL = "info"
  IMAGE_PROXY_ALLOWED_HOSTS = "spend.ctx.com,ctx-spend.s3.us-west-2.amazonaws.com"
  TRUST_PROXY = "true"
  LOOP_PHASE_1_ONLY = "true"           # add this
  LOOP_AUTH_NATIVE_ENABLED = "true"    # add this
  LOOP_WORKERS_ENABLED = "true"        # add this
  EMAIL_PROVIDER = "resend"            # add this — boot refuses "console" in production
  EMAIL_FROM_ADDRESS = "noreply@loopfinance.io"
  EMAIL_FROM_NAME = "Loop"
  LOOP_ENV = "production"
```

### A.3 Pre-flight + deploy (5 min)

```bash
./scripts/preflight-tranche-1.sh    # must report PASS
flyctl deploy -a loopfinance-api --config apps/backend/fly.toml
```

The deploy's release-command machine runs 33 SQL migrations before
the new binary takes traffic. See
`docs/phase-1-redeploy-audit.md` for the full set + failure-mode
guide.

### A.4 Smoke-test the deployed Tranche-1 binary (5 min)

```bash
curl https://loopfinance-api.fly.dev/api/config
# Expect: loopAuthNativeEnabled:true, loopOrdersEnabled:true, phase1Only:true

curl https://loopfinance-api.fly.dev/health
# Expect: status:healthy, all required workers running:true
# (payment_watcher will say lastError null only after a Horizon poll
# completes against the real deposit address — give it ~30s)
```

If `payment_watcher` reports a Horizon error, the deposit address
isn't recognised by mainnet — fix LOOP_STELLAR_DEPOSIT_ADDRESS and
redeploy.

### A.5 Bootstrap LOOP_E2E_REFRESH_TOKEN (10 min)

Once the redeployed backend is up, capture a refresh token for the
e2e workflow:

```bash
./scripts/bootstrap-e2e-refresh-token.sh \
  --backend https://loopfinance-api.fly.dev \
  --email reviewer@loopfinance.io \
  --gh-secret
```

This emails the OTP to the operator, prompts for it, exchanges it
for a refresh token, and uploads to the `LOOP_E2E_REFRESH_TOKEN`
GitHub repo secret. Once-only — workflow runs auto-rotate after.

### A.6 Run the Tranche-1 e2e once (5 min)

GitHub → Actions → **E2E (real Tranche-1 purchase + wallet)** →
Run workflow. Default settings buy a $0.02 Aerie gift card with
XLM from the test wallet. End-to-end proves the redeployed
backend's order-create + payment-watcher + procurement-worker +
fulfillment chain against real CTX. Cost: 2 cents + Stellar fees.

---

## Track B — Web first deploy + Android keystore (parallelisable)

### B.1 `loopfinance-web` first deploy (15 min)

```bash
flyctl apps create loopfinance-web
flyctl deploy -a loopfinance-web --config apps/web/fly.toml \
  --build-arg VITE_API_URL=https://api.loopfinance.io \
  --build-arg VITE_LOOP_ENV=production \
  --build-arg VITE_SENTRY_DSN=…           # optional
```

Note: `VITE_API_URL` is baked into the bundle at build time. Deploy
loopfinance-web AFTER `api.loopfinance.io` DNS resolves to the api app, or
the SPA can't reach the backend.

### B.2 DNS (~30 min, propagation can take longer)

| Hostname             | Target                                         |
| -------------------- | ---------------------------------------------- |
| `loopfinance.io`     | loopfinance-web Fly app (apex)                 |
| `www.loopfinance.io` | loopfinance-web Fly app (CNAME / apex-flatten) |
| `api.loopfinance.io` | CNAME `loopfinance-api.fly.dev`                |

Mechanics: registrar-specific. Fly's `flyctl certs add` triggers
auto-TLS once DNS resolves.

### B.3 Generate the Android release keystore (15 min)

One-time, irreversible — back this up to 1Password sealed +
offline cold storage. Losing it means losing Play Store package
identity permanently.

```bash
cd apps/mobile/android
keytool -genkeypair -v \
  -keystore loop-release.keystore \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias loop

cp keystore.properties.example keystore.properties
# Fill in the storePassword, keyPassword, alias values you set above.
```

After the keystore is on disk, the `signing.gradle` overlay (PR
#1335) automatically wires it into the release build at next
`mobile:sync` — operator runs no other gradle config.

### B.4 Add 4 GitHub repo secrets that mirror Fly secrets (10 min)

The e2e-real workflow runs an ephemeral backend in CI against real
CTX, so it needs the same Stellar / JWT secrets that production
uses:

- `LOOP_JWT_SIGNING_KEY` (same value as Fly secret)
- `LOOP_STELLAR_DEPOSIT_ADDRESS` (same value)
- `LOOP_STELLAR_OPERATOR_SECRET` (same value)
- `STELLAR_TEST_SECRET_KEY` (the funded mainnet test wallet —
  per `reference_test_wallet.md`)

Plus these from earlier session work:

- `LOOP_E2E_REFRESH_TOKEN` (from A.5)
- `GH_SECRETS_PAT` (fine-grained PAT, Secrets:Read+Write,
  rotates the refresh token after each workflow run)

Add via `gh secret set NAME --repo LoopDevs/Loop` for each.

---

## Track C — App Store Connect entry (depends on Apple approval)

App Store Connect access requires Apple Developer enrollment to be
approved. None of this is doable today — but the **content** is.

### C.1 Pre-fill the metadata fields offline

Every text field App Store Connect requires is drafted in
`docs/app-store-connect-metadata.md`:

- App Name + Subtitle
- Description (4000 char limit; current draft ~2200 chars)
- Promotional Text (170 char limit)
- Keywords (100 char comma-separated, no spaces)
- Support / Marketing / Privacy Policy URLs
- Age rating questionnaire answers
- Privacy nutrition labels (mirroring `PrivacyInfo.xcprivacy`)
- Encryption export-compliance answers
- App Review information block with reviewer-credentials script
- Screenshot shot list per device size

Reading + tweaking the copy now lets the operator copy-paste during
release week instead of authoring under deadline.

### C.2 Capture App Store screenshots (~2 hr)

Required: 6.7" iPhone (1290×2796), 6.5" iPhone (1242×2688). Optional:
iPad Pro 12.9" 6th gen (2048×2732). 5–10 shots per size.

The shot list lives in `docs/app-store-connect-metadata.md`
§Screenshots. Capture from the iOS Simulator after the first
TestFlight build is in place, or from a physical device. Status
bar should be clean (full battery, full signal, no notifications).

### C.3 Bundle ID + App Store Connect entry (post-Apple-approval, 30 min)

- Register `io.loopfinance.app` in Apple Developer portal.
- Create the App Store Connect app entry (metadata only — no
  submission for review yet).
- Add reviewers as TestFlight internal testers (no Beta App Review
  needed; up to 100 internal testers).

---

## Demo video — last (depends on everything above)

`docs/phase-1-demo-script.md` has the 12-take shot script with
voiceover beats. Record after both binaries (TestFlight build +
signed APK) are installable on physical devices, after Tranche-1
backend redeploy is healthy, and after the test wallet has been
verified can pay an Aerie order end-to-end.

Cost: $0.02 face value + Stellar fees. Use the funded test wallet
per `reference_test_wallet.md`.

---

## Order-of-operations summary

```
Today (parallel):
  ┌─ Track A: backend redeploy + e2e validation (½ day)
  ├─ Track B.1–B.2: web deploy + DNS (½ day, ops + DNS-propagation wait)
  └─ Track B.3–B.4: keystore + GitHub secrets (½ hr)

Today (independent):
  └─ Track C.1: pre-fill App Store metadata (1 hr)

When Apple approves:
  └─ Track C.3: bundle ID + ASC entry + TestFlight (½ day)

Then:
  ├─ Track C.2: capture screenshots (~2 hr)
  └─ Demo video (~½ day)
```

If Tracks A + B finish today and Apple approves on day 5, the
deliverable lands day 6–7. If Apple approves on day 1, it lands
day 2–3. The Apple Dev approval is the long pole.
