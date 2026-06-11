# Runbook · JWT signing-key rotation

## Symptom

This runbook is **planned**, not alert-driven. Rotate
`LOOP_JWT_SIGNING_KEY` (ADR-013 native auth) on a regular cadence
(quarterly recommended) or immediately if compromise is suspected.

## Severity

- Not alerted on — this is operational hygiene.
- If suspected compromise: P0. Skip the staged rotation, jump to
  "Emergency rotation" below.

## Diagnosis

Before rotating, confirm:

```bash
# Both env vars currently set on the production app?
fly secrets list -a loopfinance-api | grep LOOP_JWT_SIGNING_KEY
```

You expect `LOOP_JWT_SIGNING_KEY` set, and `LOOP_JWT_SIGNING_KEY_PREVIOUS`
either unset (no recent rotation) or holding the prior key from the
last cycle.

## Mitigation

### Staged rotation (planned)

The backend's verification path accepts tokens signed by either key
(see `apps/backend/src/auth/tokens.ts`), so a two-step rotation
preserves all in-flight sessions.

1. **Generate a new key** (32+ chars, base64 or hex; the schema rejects
   shorter):
   ```bash
   openssl rand -base64 32
   ```
2. **Move the current key into the PREVIOUS slot** so verification
   still accepts tokens minted under it:
   ```bash
   CURRENT=$(fly secrets list -a loopfinance-api --json | jq -r '.[] | select(.Name=="LOOP_JWT_SIGNING_KEY") | .Digest')
   # Note: secrets list shows digests, not values. Pull the actual
   # current value from your password manager or env.
   fly secrets set LOOP_JWT_SIGNING_KEY_PREVIOUS=<old-key> -a loopfinance-api
   ```
3. **Set the new key as the primary**:
   ```bash
   fly secrets set LOOP_JWT_SIGNING_KEY=<new-key> -a loopfinance-api
   ```
4. **Wait for the deploy to roll out** (Fly drains old machines, brings
   up new ones with both keys present). All new tokens sign with the
   new key; existing tokens still verify until they expire (15-min
   access tokens, 30-day refresh).
5. **Wait 30 days + 1 hour** (the longest possible refresh-token
   lifetime), then **clear** the previous key:
   ```bash
   fly secrets unset LOOP_JWT_SIGNING_KEY_PREVIOUS -a loopfinance-api
   ```
   Now only the new key verifies tokens.
6. **Update 1Password** with the new key. The old key entry can be
   archived once `LOOP_JWT_SIGNING_KEY_PREVIOUS` is unset.

Post in `#deployments`: "Rotated `LOOP_JWT_SIGNING_KEY`; cleared
PREVIOUS at `<timestamp>`."

### Emergency rotation (compromise suspected)

If a key is leaked, the staged rotation is too slow — every minute the
old key remains accepted is a minute of attacker validity.

1. **Generate the new key** (as above).
2. **Set the new key as primary AND clear PREVIOUS in one call**:
   ```bash
   fly secrets set LOOP_JWT_SIGNING_KEY=<new-key> -a loopfinance-api
   fly secrets unset LOOP_JWT_SIGNING_KEY_PREVIOUS -a loopfinance-api
   ```
3. **All sessions invalidate immediately** — every existing access +
   refresh token now fails verification. Users see a forced sign-out
   on next request.
4. Post in `#deployments` + `#ops-alerts`: "Emergency rotation of
   `LOOP_JWT_SIGNING_KEY` — all sessions invalidated. Users will
   re-authenticate on next request."
5. File a security incident note (channel TBD; the SECURITY.md
   reporting flow is the start).

### Admin step-up signing key (`LOOP_ADMIN_STEP_UP_SIGNING_KEY`)

ADR-028's step-up tokens are signed with a **separate** key,
`LOOP_ADMIN_STEP_UP_SIGNING_KEY` (deliberately not `LOOP_JWT_SIGNING_KEY`,
so a JWT-key compromise doesn't widen to the destructive-admin gate).
Rotate it on the same quarterly cadence, in the same session as the
JWT key. The same staged pattern applies — verification accepts either
`LOOP_ADMIN_STEP_UP_SIGNING_KEY` or `LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS`
(`apps/backend/src/auth/admin-step-up.ts`) — but the overlap window is
much shorter because step-up tokens live only 5 minutes:

1. Generate a new 32+ char key (`openssl rand -base64 32`).
2. Move the current key into the PREVIOUS slot, then set the new
   primary:
   ```bash
   fly secrets set LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS=<old-key> -a loopfinance-api
   fly secrets set LOOP_ADMIN_STEP_UP_SIGNING_KEY=<new-key> -a loopfinance-api
   ```
3. After the deploy rolls out, wait **10 minutes** (2× the 5-minute
   step-up TTL — generous), then unset the PREVIOUS slot:
   ```bash
   fly secrets unset LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS -a loopfinance-api
   ```
4. Update the password manager entry.

**Emergency variant**: set the new key and skip the PREVIOUS slot
entirely. Worst case, an admin mid-action re-confirms their password
5 minutes early — there are no long-lived step-up sessions to
preserve, so the emergency path is essentially free.

Note: if `LOOP_ADMIN_STEP_UP_SIGNING_KEY` is ever **unset** (rather
than rotated), the credit-adjust / emission / payout-retry surfaces
fail closed with 503 `STEP_UP_UNAVAILABLE` until it is restored
(ADR-028 §Activation gate).

## Resolution

Staged: tokens flow through both keys for ~30 days, then the old key
is archived. Zero user-visible impact.

Emergency: every user signs in again. Loss of session is cheap; loss
of integrity isn't.

## Post-mortem

- Emergency rotation ⇒ always. Document the leak path so the next
  compromise vector is closed.
- Staged rotation ⇒ note in the change log; no post-mortem needed.

## References

- ADR 013 (Loop-owned auth) — JWT minting + the dual-key verification
  contract.
- ADR 028 (admin step-up auth) — the step-up signing key rotated in
  the section above.
- `docs/deployment.md` env table for `LOOP_JWT_SIGNING_KEY` /
  `LOOP_JWT_SIGNING_KEY_PREVIOUS`.
- `apps/backend/src/auth/tokens.ts` — verification accepts either key.
