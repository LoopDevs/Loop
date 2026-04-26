# Runbook · Mobile signing-cert renewal

## Symptom

Calendar-driven, not alert-driven. The 30-day-out reminder fires from
the team calendar (per the policy in `docs/deployment.md` "Signing /
provisioning / cert-expiry runbook" table — A2-1205). One of:

- iOS Distribution Certificate expires in ~30 days.
- iOS Provisioning Profile expires in ~30 days (auto-renews via Xcode
  if the cert is current; if not, you'll see a 30-day reminder for
  this too).
- Apple Developer Program membership expires in ~30 days. **This is
  the most consequential** — without a current membership, every
  Apple-side artifact stops working: Push, In-App Purchase, TestFlight,
  Distribution.
- Google Play upload key (rare — 25-year lifetime; should not normally
  fire). If it does fire, escalate immediately and start the Google
  Play Support reset flow described in §"Lost upload key" below.

## Severity

- **P2** at 30 days out — plenty of runway; renew during business hours.
- **P1** at 7 days out — a missed renewal blocks every release until
  the new artifact is in place. Escalate to the on-call.
- **P0** if the cert expires while a release is in flight — every
  TestFlight + Play track upload starts failing.

## Diagnosis

Pull the calendar:

```bash
# Confirm the upcoming expiries.
# Calendar: 1Password → "Loop · Mobile signing" → Item notes
# (1Password's CLI is the easiest read; otherwise the team calendar
# has the same dates as event reminders.)
op item get "Loop · Mobile signing" --vault "Loop"
```

Cross-check against Apple Developer Center + Google Play Console for
any drift between what 1Password says and what the dashboards show.

## Mitigation

### iOS Distribution Certificate renewal

1. Apple Developer → Certificates, Identifiers & Profiles → Certificates
2. Click "+" → iOS Distribution → CSR upload (generated locally on
   the operator's offline laptop using Keychain Access).
3. Download the new certificate. Double-click to import into the
   keychain.
4. **Re-issue any associated provisioning profiles** — they auto-bind
   to the cert that's current at issue-time. Apple → Profiles → for
   each "App Store" profile in `io.loopfinance.app`, click Edit →
   Generate.
5. Download the regenerated profiles. Xcode → Settings → Accounts →
   Download Manual Profiles.
6. Verify the next release archive uses the new cert: Xcode → archive
   a TestFlight build → confirm the signing certificate panel shows
   the new identifier.
7. **Update 1Password**: archive the old `iOS Distribution
Certificate` entry, add the new one, with the new expiry date.

### Apple Developer Program membership renewal

1. Apple Developer → Membership → Renew (button visible in the 60-day
   pre-expiry window).
2. Pay the annual fee. Apple charges the credit card on file; if it's
   expired, update it first.
3. Verify the renewal lands by checking that "Distribution" remains
   available under "Certificates, Identifiers & Profiles" — without a
   current membership the pages return access-denied.
4. Update 1Password with the new membership end date.

### iOS Provisioning Profile renewal

Auto-renews when the cert is current. If you see a 30-day reminder
for the profile, the cert is the more likely cause; do that first.
Otherwise, Apple → Profiles → Edit → Generate; then re-download in
Xcode (same flow as step 4 above).

### Google Play upload key

The upload key has a 25-year lifetime — should not normally need
renewal during the lifetime of the project. If it does fire (or the
key file is lost):

1. **Lost upload key**: open a Play Support ticket. The Play app-signing
   service holds the master key; ops can request an upload-key reset
   from Support, then sign new uploads with a fresh upload-key. The
   reset takes ~3 days; ship a Discord post in `#deployments` for the
   ETA.
2. **Compromised upload key**: same flow, marked "key compromised."
   Support fast-tracks but still expect a multi-day window. **Do
   not** publish updates from the compromised upload-key in the
   meantime — every upload would force the service to reject the new
   build.

### FCM Server Key / Service-account JSON

No expiry; only rotate if compromised. Procedure:

1. Firebase Console → Project Settings → Cloud Messaging → "Generate
   New Server Key" (or rotate the service-account JSON in IAM).
2. `fly secrets set FCM_SERVER_KEY=<new>` on the backend.
3. Old key auto-invalidates in ~24h.

## Resolution

For routine renewals: a successful TestFlight + Play track upload
post-renewal confirms the new cert/profile/key works. Do this within
24h of the renewal so you're not finding out at the worst possible
moment.

For emergency renewals: post-mortem.

## Quarterly rehearsal (cross-ref A2-1909)

Quarterly: confirm the **upcoming** expiry dates in 1Password match
Apple Developer Center + Play Console. Drift surfaces if 1Password
has a stale date — typically caused by a renewal that wasn't logged
back into 1Password.

## Post-mortem

- For a missed renewal that blocked a release: always.
- For a routine renewal that ran clean: a one-line note in the change
  log; no post-mortem.

## References

- ADR-001 — Capacitor static export over remote URL.
- `docs/deployment.md` "Signing / provisioning / cert-expiry runbook"
  (A2-1205) — the lifetime + location + renewal-trigger table.
- 1Password "Loop · Mobile signing" vault — canonical store for cert
  - key + profile artefacts.
