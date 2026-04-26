# Runbook · Stellar operator-secret rotation

## Symptom

Planned operational hygiene, not alert-driven. Rotate
`LOOP_STELLAR_OPERATOR_SECRET` (ADR-016 payout-submit signer) on a
**quarterly** cadence — or immediately if compromise is suspected.

The operator secret signs every outbound LOOP-asset payout (cashback

- withdrawals). A leaked operator secret lets an attacker drain
  operator-funded LOOP balances on Stellar — high-impact, so rotation
  hygiene matters even without an active incident.

## Severity

- Not alerted on — operational hygiene.
- If compromise suspected: **P0**. Skip the staged rotation, jump to
  "Emergency rotation."

## Diagnosis

Confirm the current state:

```bash
# Confirm both env vars are set as expected on prod.
fly secrets list -a loopfinance-api | grep LOOP_STELLAR_OPERATOR_SECRET
```

You expect `LOOP_STELLAR_OPERATOR_SECRET` set, with
`LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS` either unset (no recent
rotation) or holding the prior secret from the last cycle.

`/health` shows the operator account id derived from the active
secret — useful to confirm the new secret is what's signing post-flip.

## Mitigation

### Staged rotation (planned, quarterly)

Stellar accepts payments signed by any account that has a signer
trustline. The operator-secret rotation is operationally simpler than
JWT rotation because there's no in-flight token verification window
to manage — every outbound payment carries its own signature, and
Horizon validates against the source account's current signer set.

The `_PREVIOUS` slot exists for the **opposite** reason from JWT:
during the rotation window we want to **drain in-flight payouts**
(rows already submitted under the old secret) before the old key is
removed from the source account's signers. Procedure:

1. **Generate a new keypair** locally (NEVER on a shared machine —
   Stellar private keys never leave the operator's offline laptop):
   ```bash
   stellar-cli keys generate operator-2026-Q3
   ```
   Note both the public address (G…) and the secret (S…).
2. **Add the new public key as a signer** on the operator account
   alongside the old one, with the old key still at full weight:
   ```
   AddSigner: operation_type = SET_OPTIONS,
              ed25519PublicKey = <new G...>,
              weight = 1
   ```
   Submit this op signed by the old key. Now the account has two
   signers; both can authorise payments.
3. **Set `LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS=<old-secret>`** so
   the payout-submit worker still reads the old secret as a fallback
   if it ever needs to (the worker prefers the new one going forward;
   PREVIOUS is a fallback purely for the rotation window).
4. **Set `LOOP_STELLAR_OPERATOR_SECRET=<new-secret>`** on Fly. The
   rolling restart picks the new secret up; new payouts sign under
   the new key.
5. **Wait for the in-flight `state='submitted'` payouts to drain to
   `confirmed`**. Watch `/admin/payouts?state=submitted` until empty
   (~5 min typical, 30 min absolute upper bound — the
   payout-watchdog backstop kicks in past that).
6. **Set the old key's signer weight to 0** on the operator account
   via `SET_OPTIONS`, signed by the new key. The old key can no
   longer authorise payments.
7. **Unset `LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS`** on Fly. Now only
   the new secret is the signer.
8. **Update 1Password** with the new secret. Archive the old entry.

Post in `#deployments`: "Rotated `LOOP_STELLAR_OPERATOR_SECRET`; old
key signer-weight zeroed on operator account at `<timestamp>`."

### Emergency rotation (compromise suspected)

If the secret is leaked, the staged rotation is too slow — every
minute the old key remains a signer is a minute the attacker can
authorise transfers.

1. **Generate the new keypair** (as above).
2. **Add new key as signer + zero out old key in one `SET_OPTIONS`
   transaction** signed by the (still-valid) old key:
   ```
   AddSigner(new, weight=1) + SetSigner(old, weight=0)
   ```
   Submit immediately. Once this transaction confirms (≤7s typical
   on Stellar), the leaked key has zero authority.
3. **Flip the Fly secrets** to the new value, `_PREVIOUS` cleared:
   ```bash
   fly secrets set LOOP_STELLAR_OPERATOR_SECRET=<new-secret> -a loopfinance-api
   fly secrets unset LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS -a loopfinance-api
   ```
4. **Sweep operator balance** to a fresh cold-storage account if
   compromise was active — even after zeroing the signer weight, the
   attacker may already have authorised a payment in-flight.
5. Post in `#deployments` + `#ops-alerts`: "Emergency Stellar
   operator-secret rotation. Old key zeroed at `<tx-hash>`. Balance
   swept to cold storage at `<tx-hash>`."
6. File a security incident note (per `SECURITY.md`).

## Resolution

Staged: ~1 day end-to-end (steps 1–4 in <30 min, then a 24h
observation window before steps 5–7). Zero user-visible impact.

Emergency: under 5 minutes if executed sharply. Brief failed-payout
window during the Fly rolling restart is acceptable; the
payout-watchdog re-claims any submit attempts that hit the in-between
state.

## Quarterly rehearsal (A2-1909)

Rehearse the **staged** rotation on the staging operator account
every 90 days. Check:

- Do steps 1–8 still work end-to-end? Stellar and Fly APIs sometimes
  shift; the runbook drifts.
- Does `/health` reflect the new operator address post-flip?
- Time the rotation. Target: <30 min for staged, <5 min for
  emergency.

Post the rehearsal log in `#deployments` (date, target signer SHA,
timing, anything that broke).

## Post-mortem

- Always for emergency rotation — document the leak path so the next
  vector is closed.
- Staged rotation: a one-line note in the change log; no post-mortem.

## References

- ADR-016 — Stellar SDK payout submit + the operator-secret env-var
  contract.
- `apps/backend/src/payments/payout-worker.ts` — submit path that
  reads `LOOP_STELLAR_OPERATOR_SECRET`.
- `docs/deployment.md` env table for the secret + `_PREVIOUS` slot.
- `runbooks/jwt-key-rotation.md` — sister procedure for the
  signing-key rotation; same staged-vs-emergency shape, different
  underlying mechanic (JWT verifies dual-key in code; Stellar
  multiplies authority via signer weights at the chain).
