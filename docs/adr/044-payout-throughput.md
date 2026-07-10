# ADR 044: Stellar payout throughput — channel accounts

Status: Accepted (design) — Phase 1 (scaffold) implemented; Phase 2 (operator
channel provisioning) is an operator follow-up
Date: 2026-07-10
Related: ADR 016 (Stellar SDK payout submit), ADR 024 (withdrawal → emission
writer), ADR 036 (cashback token lifecycle), ADR 038 (money-path hardening)
Resolves: readiness-backlog S4-1 / go-live-plan §T1-H S4-1

## Context

Every value-out flow (order cashback emission, nightly GBPLOOP interest
mint, admin-driven emission/withdrawal) funnels through `pending_payouts` →
the payout worker (`payments/payout-worker.ts`) → one Stellar submit per
row (`payments/payout-submit.ts`, ADR 016).

Stellar accounts have exactly one thing that makes concurrent submission
hard: a **sequence number**. Every transaction from an account must carry
`sequence = account.sequence + 1`, and Horizon accepts at most one
transaction per sequence value. Two transactions racing to submit
`sequence + 1` from the same account — even from two different processes
that both did a fresh `loadAccount` — means one wins and the other fails
`tx_bad_seq`.

Today's design (ADR 016 + hardening A8) makes this safe by making
submission **fully serial**:

- One operator account (`LOOP_STELLAR_OPERATOR_SECRET`) signs every payout
  (plus per-asset issuer accounts for `kind='interest_mint'` rows, ADR
  031 — same problem, one sequence number per issuer).
- `listClaimablePayouts` claims rows with `FOR UPDATE SKIP LOCKED` (CF-14)
  so two Fly machines get disjoint row batches — but that alone doesn't
  stop them colliding on the _shared account's_ sequence number, so
  hardening A8 added a fleet-wide advisory lock (`withAdvisoryLock` +
  `payoutLeaderLockKey`) that single-flights the **entire tick** — only
  one machine drains `pending_payouts` at any moment.
- Within that one machine's tick, `runPayoutTickLocked` submits rows in a
  plain `for` loop, awaiting each `payOne` before starting the next — so
  even a single machine never has two in-flight submits against the same
  account.

This is correct (INV-9 holds: at most one landed payment per payout
intent) but it's a **hard throughput ceiling**: one account, one sequence
number, one submit in flight fleet-wide, each bounded by a Horizon
round-trip (order ~1-5s, worse under network congestion). A backlog of
10,000 rows (a plausible Phase-2 interest-mint night, per the
readiness-backlog S4-1 estimate) takes on the order of hours to drain no
matter how many Fly machines or CPU cores are thrown at it — horizontal
scaling doesn't touch this bottleneck because the bottleneck isn't
compute, it's **one shared counter**.

## Decision

### Chosen: channel accounts (the standard Stellar scale pattern)

Stellar's own docs name this exact pattern "channel accounts" — used by
every high-throughput Stellar issuer (anchors, DEXes) for the identical
problem. The idea:

- Provision **N additional funded Stellar accounts** ("channels"). They
  hold no meaningful balance of anything — just enough XLM for the
  account's base reserve (Stellar requires ~1 XLM minimum to exist) plus
  a working float for transaction fees.
- A channel account is the transaction's **source** — it owns the
  sequence number being consumed and pays the fee — but the actual
  **Payment operation** inside that transaction can carry its own
  op-level `source` override, naming the real funding account (the
  operator, or an ADR 031 issuer for interest mints). Stellar requires
  the transaction to be signed by BOTH the tx-source keypair (channel)
  and the op-source keypair (funding account) when they differ, so a
  channel-only compromise cannot forge a payment — see Security below.
- **N channels → N independent sequence counters → N submits genuinely
  in flight at once**, with zero risk of `tx_bad_seq` between them,
  because each one is consuming a _different_ account's sequence number.
  The funding account's own balance and trustlines are completely
  unaffected — the channel is pure sequence-number/fee plumbing.

This is additive over ADR 016's existing state machine — it changes
**what account submits the transaction**, not **which account the money
moves through** or **how a row's lifecycle is tracked**.

### Options considered

| Option                                               | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Channel accounts** (chosen)                        | Idiomatic Stellar scale pattern. Bounded, auditable blast radius per channel (see Security). No change to the funding account's balance/trustline model. Horizontally provisionable — N is an operator dial, not a code change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Multiple operator accounts** (shard by user/asset) | Considered and rejected as the _primary_ lever. Splitting the funding account itself means splitting the LOOP-asset balance / trustline / issuer relationship across accounts too — every downstream reader (treasury view, drift watcher, admin payouts-by-asset) would need to aggregate across shards. Channel accounts get the same sequence-parallelism without touching the money-holding topology at all.                                                                                                                                                                                                                                                                                                                                      |
| **Fee-bump transactions**                            | Solves a different problem (letting an unfunded destination's fee be sponsored) — already used elsewhere (ADR 030 Phase C3 wallet flows) but orthogonal to _this_ bottleneck. A fee-bump still has exactly one inner-tx sequence number; it doesn't add parallelism.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Batching (multiple payment ops per tx)**           | Cuts transaction _count_ (~90% fewer fees per ADR 016's "Deferred" section) but not sequence-number parallelism — a 100-op batch tx is still one sequence number, one submit, and now the unit of atomicity is the whole batch: a single `op_no_trust` in operation 47 could abort or partially apply the other 99, which directly complicates the per-payout idempotency (CF-18) and CAS state machine INV-9 depends on. Rejected as the primary lever for the reasons the task anticipated; may be revisited later as an orthogonal fee-reduction optimization once channels are proven, but each batched tx would still need to map cleanly back to N individual `pending_payouts` rows without breaking "one outbound payment per payout intent." |

### What does NOT change

- **The funding account model.** The operator account still holds the
  LOOP-asset balance and signs (authorizes) every payment. Issuer
  accounts still sign `interest_mint` rows (ADR 031). Channels never
  hold or move the payout asset.
- **Idempotency (CF-18).** The idempotency pre-check
  (`findOutboundPaymentByMemo` / `getOutboundPaymentByTxHash`) scans the
  **funding (signer) account's** payment history — exactly as before.
  Channels are invisible to this check because the Payment operation's
  `from` is still the funding account regardless of which channel paid
  the fee. A row's hash is deterministic on the full signed envelope
  (tx source + sequence + operations + memo + fee), so CF-18's
  hash-before-submit persistence and authoritative re-check work
  identically whether or not a channel was used to submit it.
- **The CAS state machine.** `markPayoutSubmitted` /
  `recordPayoutTxHash` / `markPayoutConfirmed` / `markPayoutFailed` are
  completely unaware of channels — they operate on `pending_payouts.id`
  and don't care which Stellar account paid the fee.
- **The fleet-wide leader lock (hardening A8).** Still exactly one Fly
  machine ticks at a time. Channels add parallelism **within** that one
  machine's tick, not across machines. See "Why keep the fleet-wide
  lock" below.
- **The CF-14 `FOR UPDATE SKIP LOCKED` claim.** Still the mechanism that
  gives disjoint row batches when multiple machines _do_ race (the
  cross-machine residual A8 already documents — a hung leader whose
  lease expires). No change needed: claiming disjoint rows was already
  solved; channels only change what happens to a claimed row.

### What DOES change: within-tick parallel dispatch by channel

`runPayoutTickLocked` (`payments/payout-worker.ts`) claims its batch of
rows exactly as before, then:

1. Resolves the configured channel accounts (`resolvePayoutChannels()`,
   from `LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS` — see Configuration below).
2. **Zero channels configured (default):** unchanged. Every row is
   processed in the same sequential `for` loop as pre-ADR-044, with no
   `channelSecret` ever passed to `payOne`/`submitPayout` — this is the
   exact same code path, byte-for-byte, that shipped under ADR 016/A8.
   This is what "N=1 preserves today's behaviour" means concretely: there
   is no separate "N=1 mode" to get subtly wrong, there is just "channels
   configured" vs. "not."
3. **N channels configured:** the claimed batch is partitioned into N
   shards (round-robin by claim order, `rows[i % N]`). Each shard is
   processed by its own sequential loop (a shard's own rows still await
   each other — a channel's sequence number is exactly as serial
   internally as the operator's is today), and the N shards run
   concurrently via `Promise.all`. Each row in shard `k` is submitted
   with `channelSecret = channels[k].secret`, which `submitPayout` uses
   as the transaction source (see "Submit-primitive changes" below).

This gives **N submits genuinely in flight at once**, bounded by N, with
every existing per-row guarantee (idempotency, CAS, retry/fee-bump
classification) completely unchanged per row — only the "what waits for
what" shape changes, from "everything serial" to "N independent serial
queues."

### Submit-primitive changes (`payments/payout-submit.ts`)

`submitPayout` gains an optional `channelSecret`:

- **Unset (default):** identical to pre-ADR-044 — the funding keypair is
  both the transaction source (sequence + fee) and the payment's implicit
  `from`. One signature.
- **Set:** the channel keypair becomes the transaction source
  (`loadAccount(channel.publicKey())`, sequence + fee); the Payment
  operation gets an explicit `source: fundingKeypair.publicKey()`
  override so the payment still debits the funding account; the
  transaction is signed by **both** keypairs (Stellar requires every
  distinct `source` referenced in a transaction — tx-level and any
  op-level override — to have signed).

This is purely additive to the function signature; every existing caller
(pay-CTX forwarding via `submitNativePayment`, wallet fee-bump via
`submitPreSignedTransaction`) is untouched.

### Why keep the fleet-wide leader lock (A8) for Phase 1 of this ADR

The obviously more scalable design would let _every_ Fly machine run
channel shards concurrently — N channels × M machines in flight. That
requires each **channel** (not just each tick) to be single-flighted
fleet-wide, i.e. per-channel advisory locks, be held for the channel's
whole shard, and a lease/hand-back story identical to A8's but N times
over. That is real additional complexity and a real additional way to
get INV-9 wrong (a channel-lock bug reintroduces exactly the
cross-machine sequence race A8 was built to close, now on N accounts
instead of one).

Keeping the existing fleet-wide tick lock sidesteps that entirely: since
only one machine is ever inside `runPayoutTickLocked` at a time, no two
machines can ever touch the same channel (or the operator account, or
any issuer account) concurrently, by construction — the exact same
argument that makes today's single-account design safe extends
unchanged to N channels. The cost is that the achievable parallelism is
bounded by N **within one machine's tick**, not N × (machine count). For
the volumes named in S4-1 (thousands of interest mints, not millions),
N in the 5-20 range already turns an hours-long serial drain into
minutes, which is the actual near-term problem. Removing the fleet-wide
lock in favour of per-channel fleet-wide locks is a legitimate future
increment (tracked below) once N-channel throughput is proven in
production and the ceiling above becomes the binding constraint.

### Configuration

```
# Comma-separated list of pre-funded Stellar secret keys. List length
# IS the channel count N — there is no separate count var to drift out
# of sync with the secrets. Unset/empty (default) → N=0 → the worker's
# original fully-serial, single-account path, unchanged.
LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS=SCHANNEL1...,SCHANNEL2...,SCHANNEL3...
```

Boot validation (`env.ts`, mirroring the ADR 031 issuer-secret
cross-field checks):

- Each entry must be a well-formed Stellar secret key.
- No two entries may derive the same account (a duplicated channel
  defeats its own purpose and, worse, would let two shards race the
  _same_ account's sequence number within one tick — exactly the bug
  this ADR exists to avoid).
- No entry may derive the same account as the operator
  (`LOOP_STELLAR_OPERATOR_SECRET`) or any configured issuer
  (`LOOP_STELLAR_<ASSET>_ISSUER_SECRET`) — reusing one of those as a
  "channel" would silently reintroduce the exact sequence collision
  channels exist to eliminate, between the channel-as-itself submit
  path and the direct operator/issuer submit path.

`payments/channel-accounts.ts` re-derives and re-asserts these
invariants at resolve time (same defence-in-depth posture as
`issuer-signers.ts` — protects test environments that mock `env.js`
inconsistently with `parseEnv`).

### Security

**Blast radius of a compromised channel secret is deliberately small.**
A channel key alone cannot move the operator's or an issuer's funds — a
payment whose op-level `source` is the operator/issuer account requires
that account's signature, which a channel-only compromise doesn't have.
The worst a leaked channel secret enables is: (a) draining the channel's
own (intentionally minimal) XLM balance, or (b) submitting throwaway
transactions from that account that bump its own sequence number,
which — because every submit does a fresh `loadAccount` immediately
before building (unchanged from ADR 016) — costs the worker at most a
wasted read, never a corrupted submit. This is a materially smaller
blast radius than the operator or issuer secrets, which is the intended
shape: N channel secrets is N times the key-management surface, so each
one should be worth far less to an attacker than the operator key. See
`docs/threat-model.md` for the updated asset-table entry.

**Never logged.** `channelSecret`, `*.channelSecret`, and
`LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS` join the pino redaction allowlist
(`logger.ts`), mirroring the operator/issuer secret entries.

### INV-9 under the new concurrency model — the argument

INV-9 ("A `pending_payouts` row is submitted to Stellar at most once")
must hold with N shards running concurrently within one machine's tick,
same as it held with the fully-serial loop. Walking the argument:

1. **No two shards can process the same row.** Rows are partitioned by
   claim-order index (`i % N`) from a single already-claimed array — the
   partition is a pure in-memory split of one process's own claimed
   batch, not a second database claim. There's nothing to race: row `i`
   belongs to shard `i % N` by construction, full stop.
2. **No two shards can share a channel's sequence number.** Each shard
   is assigned exactly one channel account and processes its rows in a
   plain sequential `for` loop (identical serial-await shape to
   pre-ADR-044) — a shard never has two in-flight submits against its
   own channel. Different shards use different channel accounts, so
   there is no shared sequence number between them to race in the first
   place — this is the core of why channel accounts solve the problem
   structurally rather than by locking harder.
3. **The CAS claim (`markPayoutSubmitted`, state-guarded on `pending`)
   still gates every row exactly once**, regardless of which shard calls
   it — this logic is untouched. A row a shard is about to submit was
   already claimed from the DB (state guard) before any Stellar call
   happens, same as before.
4. **CF-18 (hash-before-submit, authoritative re-check) still closes the
   crash/retry double-pay window per row**, regardless of channel — the
   hash is deterministic on the full envelope (which now happens to
   include a channel-sourced sequence number, but that's just more
   entropy in the same deterministic hash, not a new dependency), and
   the re-check scans the **funding account's** history, unaffected by
   which channel a prior attempt used.
5. **Cross-machine safety is unchanged** because the fleet-wide leader
   lock (A8) is unchanged — only one machine is ever inside
   `runPayoutTickLocked`, so the N-shard argument above only ever has to
   hold within a single process, where steps 1-2 are a closed argument
   (no I/O, no interleaving with another claimer) and steps 3-4 are the
   same DB/Horizon guarantees ADR 016/A8 already established.
6. **A crashed machine mid-tick** leaves its claimed-but-unsubmitted
   rows in `pending` (never reached `markPayoutSubmitted`) or `submitted`
   (reached it, crashed before confirm) exactly as before — the existing
   A2-602 stale-`submitted` watchdog re-claim picks them up on a later
   tick via `reclaimSubmittedPayout`'s attempts-CAS, then that later
   tick's own shard partition (possibly a different N, if the operator
   changed the channel count between ticks) picks them up again. Nothing
   about the reclaim path assumes the same channel handles a row twice.

Net: INV-9's proof is unchanged in every step that mattered before; the
new step (partitioning into shards) is provably collision-free because
it's a pure in-memory split with no shared mutable state between shards
other than the process-local `result` counters (safe under
JS's single-threaded cooperative concurrency — increments never
interleave mid-operation).

## What shipped in this PR vs. deferred

**Shipped (Phase 1 — the safe first increment):**

- This ADR.
- `payments/channel-accounts.ts` — resolves `LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS`
  into validated `{ secret, account }` signer records.
- `env.ts` boot validation (format, dedupe, collision-with-operator/issuer).
- `submitPayout` gains `channelSecret` (additive; unset = unchanged).
- `payout-worker-pay-one.ts` threads an optional `channelSecret` through
  `payOne` → `submitPayout`.
- `payout-worker.ts` shards a claimed batch across configured channels
  and runs shards concurrently via `Promise.all`; zero channels (default)
  is the exact pre-ADR-044 code path.
- Pino redaction, `.env.example`, `docs/development.md`,
  `docs/threat-model.md`, `docs/invariants.md` (INV-9 note).
- Unit coverage: per-channel sequence isolation + dual-signature shape
  (`payout-submit.test.ts`), shard partitioning + within-shard
  seriality + cross-shard concurrency + N=0 exact-passthrough
  (`payout-worker.test.ts`), env boot-validation (`env.test.ts`),
  channel resolution (`channel-accounts.test.ts`), redaction
  (`logger.test.ts`).
- The CF-14 `FOR UPDATE SKIP LOCKED` disjoint-claim proof this ADR
  leans on for "no two shards see the same row" already exists (real
  Postgres, `__tests__/integration/payout-worker.test.ts`, predates this
  ADR) — re-verified as still passing, not duplicated.

**Deferred (explicitly out of scope for this PR):**

- **Actually provisioning + funding channel accounts in production.**
  This ADR ships with `LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS` unset, so
  production behaviour is **unchanged** until an operator creates N
  funded Stellar accounts and sets the env var (👤 operator action,
  tracked in go-live-plan §T1-H / readiness-backlog S4-1). Suggested
  provisioning: `Keypair.random()` per channel, fund each with Friendbot
  (testnet) or a small XLM transfer (mainnet, base reserve + fee float —
  a few XLM is generous headroom), no trustlines needed (channels never
  hold the payout asset).
- **Per-channel fleet-wide locking to lift the single-leader ceiling.**
  Tracked as a follow-up once N-channel throughput within one leader is
  proven and becomes the binding constraint (see "Why keep the
  fleet-wide leader lock" above).
- **Cancelling in-flight shards on an A8 lease timeout.** The A8 lease
  race (`runPayoutTick`) releases the leader lock if the tick body hangs
  > 90s, but the raced-away `runPayoutTickLocked` promise is not
  > cancelled — it runs to completion in the background. Pre-ADR-044 that
  > orphaned at most one in-flight submit; with N channels it can orphan
  > up to N (one per shard). This does NOT break INV-9 (CAS + CF-18 are
  > per-row and channel-agnostic), but it N-scales the already-accepted
  > A8 hung-leader `tx_bad_seq`/retry-churn residual — recorded in
  > `docs/threat-model.md`'s accepted-risk register. An `AbortController`
  > threaded into the shard loops (stop starting new rows once the lease
  > trips) is the durable fix, naturally paired with the per-channel
  > fleet-wide-locking follow-up above.
- **Raising `PAYOUT_TICK_LEASE_MS` / the tick `limit` in tandem with N.**
  The existing 90s lease and default `limit=5` are untouched; an
  operator who raises `LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS` to N channels
  should also raise `limit` (via the worker's `limit` config surface) to
  actually see throughput benefit — with `limit=5` and N=5 each shard
  gets ~1 row, which drains as fast as before just with less noise.
  Documented as an operator tuning note rather than an automatic
  coupling, so the lease/limit relationship stays an explicit,
  reviewable choice rather than implicit scaling.
- **Batched submission** (multiple payment ops per tx) — still deferred
  per ADR 016, and now additionally deprioritized by this ADR's
  rejection above.

## Rollout checklist

- [x] ADR (this document).
- [x] `payments/channel-accounts.ts` + boot validation + redaction.
- [x] `payout-submit.ts` — `channelSecret` support.
- [x] `payout-worker-pay-one.ts` / `payout-worker.ts` — shard dispatch.
- [x] Unit + integration coverage (see "What shipped" above).
- [x] Docs: this ADR, `docs/invariants.md`, `docs/threat-model.md`,
      `docs/development.md`, `AGENTS.md`, `.env.example`.
- [ ] 👤 Operator: provision + fund N channel accounts for production,
      set `LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS`, confirm a real backlog
      drains N× faster than the pre-ADR-044 baseline.
- [ ] Tick `docs/readiness-backlog-2026-07-03.md` S4-1 and
      `docs/go-live-plan.md` §T1-H S4-1 — code half done in this PR;
      leave the checkbox open until the operator step above lands (the
      item's "Done when" is throughput actually scaling in production,
      not just the capability existing dark).
