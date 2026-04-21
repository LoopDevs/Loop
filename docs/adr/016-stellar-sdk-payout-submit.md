# ADR 016: Stellar SDK for outbound payout submission

Status: Proposed
Date: 2026-04-21
Related: ADR 015 (stablecoin topology), ADR 010 (principal switch)

## Context

ADR 015 landed the data layer for outbound cashback payouts:
`pending_payouts` rows are written on `markOrderFulfilled`, and the
admin surface shows backlog counts + a drilldown list + a retry
endpoint. The last piece is a **submit worker** that reads
`pending_payouts` rows, builds a Stellar `Payment` operation, signs
it with the operator account's secret key, and submits via Horizon.

So far the backend has avoided a Stellar SDK dependency:

- The **watcher** parses Horizon JSON directly (`payments/horizon.ts`)
  because it only _reads_ — a narrow `fetch`-backed client stays
  dep-free.
- The **balance reader** (`payments/horizon-balances.ts`) does the
  same — a single `/accounts` read with Zod validation.

The payout path is the first code that **writes** to Stellar, and
writing requires:

- Canonical transaction envelope construction (XDR).
- ED25519 signing against a sequence number + network passphrase.
- Submission to Horizon's `/transactions` endpoint with retry on
  bad-sequence and timeout-replacement semantics.
- Handling `timebounds`, minimum fees, and base reserves correctly.

Rolling our own XDR is a non-starter: the ed25519 keypair
arithmetic + CAP-5 base-reserve accounting + fee-bump transaction
support + sequence-number races add up to hundreds of lines of
security-critical crypto that's one bug away from a lost payout or
a signing-key leak.

## Decision

### Add `@stellar/stellar-sdk` as a backend dependency

Use `@stellar/stellar-sdk` (the official SDK from the Stellar
Development Foundation) for:

- Building the `Payment` operation (destination, asset, amount).
- Loading the operator account + its current sequence number.
- Building + signing the `TransactionBuilder` output with the
  operator's `Keypair`.
- Submitting the signed XDR to Horizon.
- Parsing the submit result (success + tx hash vs.
  `tx_bad_seq`, `op_no_trust`, etc.).

`@stellar/stellar-sdk` is already a peer dependency the web app
uses via the wallet flow (ADR 009 Phase 2), so the team and the
audit surface are familiar with it. Bundle cost is not a concern
on the backend; Node process memory dwarfs the SDK size.

### What the SDK is **not** used for

- **Reading operations.** The watcher's `listAccountPayments` stays
  fetch-backed. Same for `getAccountBalances`. Pulling the SDK's
  `Horizon.Server` into the read path would couple the watcher to
  the SDK's retry + caching opinions, which we've deliberately kept
  simple.
- **Client-side signing.** Users still sign their own wallet
  transactions via the native Stellar SDK integration already in
  the web app; this ADR is purely about Loop's operator-side
  signing.
- **Soroban / smart contracts.** Out of scope for ADR 015; if we
  eventually need Soroban (e.g. on-chain liquidity rails) that's a
  separate ADR.

### Signing-key management

The operator's Stellar secret key lives in a new env var:

```
LOOP_STELLAR_OPERATOR_SECRET=S...
```

Rules:

- **Never logged.** Pino redaction picks this up via the existing
  secret-keys allowlist (`auth/jwt` signing key, etc.).
- **Never surfaced in `/health` or any admin endpoint.** Presence
  is checked at boot; absence disables the payout worker (payout
  rows stay `pending` and ops handles them manually).
- **Rotation** via `LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS` during
  the migration window, mirroring the JWT signing-key rotation
  pattern. Both keys can submit; only the new key writes fresh
  submissions.

Production deployment stores the secret in Fly.io secrets (already
the pattern for DB URL, JWT key, etc.).

### Submit-worker design

Periodic interval (default 30s, env-tunable via
`LOOP_PAYOUT_WORKER_INTERVAL_SECONDS`). Each tick:

1. `listPendingPayouts(limit=5)` — FIFO drain, small batch per
   tick to cap outstanding risk.
2. For each row, in order (no parallelism — sequence numbers
   serialise on the operator account, and parallel submits would
   race):
   1. **Idempotency check first.** Before we attempt a submit,
      query Horizon for payments from the operator account to
      `row.toAddress` with `memo = row.memoText`. If found →
      `markPayoutConfirmed({ id, txHash: <observed-hash> })` and
      skip the submit. Closes the "tx landed async after a prior
      timeout" loop — see "Retry + idempotency" below.
   2. `markPayoutSubmitted(id)` — state-guarded transition bumps
      `attempts`. If null, another worker beat us; skip.
   3. Build + sign via SDK using the pinned
      `{ assetCode, assetIssuer, toAddress, amountStroops, memoText }`
      on the row. Sequence number is fetched fresh from
      `Server.loadAccount(operator)` each submit so a prior
      `tx_bad_seq` or timeout doesn't poison subsequent attempts.
      Timebounds set to `{minTime: now, maxTime: now + 60s}` so
      a timed-out tx can't land after we've rebuilt.
   4. Submit to Horizon. On success, capture the tx hash →
      `markPayoutConfirmed({ id, txHash })`. MVP treats SDK
      success as confirmation; Horizon's submit endpoint already
      waits for ledger close.
   5. On a **transient** error (see policy below), leave the row
      in `submitted` and let the next tick retry — the idempotency
      check at step 2.1 guards against double-sends if the prior
      tx actually landed.
   6. On a **terminal** error, `markPayoutFailed({ id, reason })`.
3. Log a tick summary (picked / confirmed / failed / retried) at
   info level when non-zero.

### Retry + idempotency

Automatic retry is bounded and idempotent. The policy distinguishes
**transient** (retry on next tick) from **terminal** (fail now,
require admin retry):

| Failure                                       | Classification | Notes                                                                                      |
| --------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| Network error / `fetch` throw                 | Transient      | Horizon blip, retry on next tick.                                                          |
| Horizon 5xx                                   | Transient      | Upstream blip.                                                                             |
| `tx_bad_seq`                                  | Transient      | Another operator submit took our seq; rebuild with fresh seq on retry.                     |
| `tx_too_late` (timebounds expired)            | Transient      | Submission didn't land in time; safe to rebuild — the expired tx can't land retroactively. |
| `tx_insufficient_fee`                         | Transient      | Fee surge; retry with a bumped base fee.                                                   |
| `op_no_trust` (destination missing trustline) | Terminal       | User needs to add the LOOP asset trustline. Admin retry after they do.                     |
| `op_underfunded` (operator out of asset)      | Terminal       | Ops must top up the issuing reserve. Admin retry when fixed.                               |
| `tx_bad_auth` (signing key wrong)             | Terminal       | Configuration bug. Admin retry after key rotation.                                         |
| Malformed destination / amount                | Terminal       | Row-level corruption. Admin investigates.                                                  |

Transient retry caps at `MAX_ATTEMPTS = 5` (configurable via
`LOOP_PAYOUT_MAX_ATTEMPTS`). The `pending_payouts.attempts` column
(ADR 015) is the counter; when it reaches the cap, the next
transient error promotes to `failed` terminal state so ops sees
the row on the admin drilldown (#350) rather than the worker
grinding forever.

**Why the idempotency pre-check is safe against double-sends:**

1. Stellar tx hashes are deterministic on the signed envelope. A
   network-level dedupe (same signed XDR replayed) returns the
   original tx hash, not a second tx.
2. Our memo (`order.id`) is globally unique per payout row. If a
   prior submit landed after we marked it `submitted` but before
   we could record the hash (Node crash, network partition), the
   _next_ tick sees the payment in Horizon's history and converges
   to `confirmed` without issuing a second submit.
3. Sequence numbers are fetched fresh per submit, so a stale seq
   from a prior timeout doesn't cause `tx_bad_seq` on the retry —
   and if it does, the classification above says "retry fresh"
   rather than "fail".

The combination — pre-flight memo check + fresh-seq rebuild +
bounded attempts + strict transient/terminal split — gives us
at-least-once delivery without at-least-twice risk.

### What doesn't change

- `credits/payout-builder.ts` (ADR 015) stays pure. The SDK lives
  in a new `payments/payout-submit.ts` module that takes an intent
  - operator keypair and returns a tx hash / throws.
- `pending_payouts` schema. The existing state machine (pending →
  submitted → confirmed / failed) already models the SDK's return
  shape.
- Admin retry flow. `POST /api/admin/payouts/:id/retry` (#351)
  keeps the manual-retry semantics; unbounded automatic retry
  would mask real signing / sequence-number issues.

## Consequences

### Positive

- **Correctness.** No home-grown XDR or ed25519 code. The SDK is
  the canonical reference implementation; upgrades pick up
  consensus-level changes for free.
- **Minimal new surface.** One module (`payout-submit.ts`), one env
  var (`LOOP_STELLAR_OPERATOR_SECRET`), one new periodic timer.
  Everything else was already built by ADR 015.
- **Testable.** The SDK's `TransactionBuilder` takes a mock-friendly
  `Horizon.Server` instance; tests can stub the submit response
  without spinning up testnet.

### Negative

- **Bundle weight** on the backend Docker image grows by ~1-2 MB.
  Material for Lambda / edge runtimes; irrelevant for our Fly.io
  Node deployment.
- **Signing key in operator memory.** Any backend compromise that
  reads process memory reads the Stellar secret. Mitigations:
  - Secret lives only in env, read at boot, never written to disk.
  - The backend process runs with memory-locked heap on Fly.io's
    production class.
  - Future: KMS-wrapped secret + signature delegation to a separate
    signing service (out of scope for MVP).
- **Operator account = single point of failure.** If it runs out of
  XLM base reserves or loses its secret, payouts stop. Ops monitors
  the balance via the admin treasury view (#343 / #349).

### Deferred

- **Fee-bump transactions** for ops-paid fees when the destination
  account is unfunded. Every MVP payout is to a funded wallet that
  already has a trustline to the LOOP asset — `op_no_trust` failure
  falls back to the admin retry path.
- **Hardware signing module** for the operator secret. Software
  signing is adequate for launch volume; HSM integration is a
  future ops-hardening slice.
- **Batched submission** (multiple payouts per Stellar tx).
  Stellar allows up to 100 operations per transaction; batching
  would cut per-payout fees by ~90% at scale. MVP goes one-per-tx
  for simpler retry semantics.

## Rollout checklist

- [ ] `npm install @stellar/stellar-sdk` in `apps/backend/`.
- [ ] Env var `LOOP_STELLAR_OPERATOR_SECRET` validated in `env.ts`
      with a `^S[A-Z2-7]{55}$` regex. Absent → payout worker
      disabled (logged once at boot).
- [ ] `payments/payout-submit.ts` — pure wrapper that takes a
      `{ secret, horizonUrl, networkPassphrase, intent }` and
      returns a tx hash or throws.
- [ ] `payments/payout-worker.ts` — interval loop wiring + tick
      function.
- [ ] `index.ts` — start the worker at boot behind
      `LOOP_WORKERS_ENABLED`, same feature-flag pattern as the
      payment watcher + procurement worker.
- [ ] Pino redaction — ensure `LOOP_STELLAR_OPERATOR_SECRET` is in
      the redact allowlist.
- [ ] Admin treasury `operatorAccount` card — surface the operator
      pubkey + XLM reserve + configured-or-not for each LOOP asset
      so ops sees at a glance whether the payout path is live.

## Open questions

- **Trustline-probe before submit?** Pre-checking
  `getAccountBalances(toAddress).contains(LOOP asset)` would catch
  `op_no_trust` before a wasted submit. Adds a Horizon read per
  payout. MVP skips the probe; `markPayoutFailed` on `op_no_trust`
  is acceptable, the admin retry flow covers it.
- **Attempt-counter reset on retry?** When an admin clicks retry
  on a `failed` row, should `attempts` reset to 0 or continue
  counting? MVP resets (admin retry = fresh 5-attempt budget)
  because the operator's manual review is the signal that the
  terminal condition is cleared. If we see operators
  repeatedly-retrying the same row, the counter resetting
  masks the pattern; a future audit event can capture the retry
  itself.
