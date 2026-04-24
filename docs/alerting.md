---
title: Alerting tiers and paging policy
---

# Alerting tiers and paging policy

> Closes A2-1327. Prior to this document Discord was the only alert
> surface — every notifier in `apps/backend/src/discord.ts` posts to
> one of three Discord channels, and a Discord outage (or an
> operator who isn't watching) meant ops was blind. This doc pins
> what we accept under that constraint and names the Phase-2
> hardening path.

## Today (Phase 1)

**Single tier, single surface.** All alerts land in Discord via three
webhooks configured at deploy time:

| Channel       | Env var                       | What fires there                                             |
| ------------- | ----------------------------- | ------------------------------------------------------------ |
| `orders`      | `DISCORD_WEBHOOK_ORDERS`      | Every order created / fulfilled + cashback credit / recycle  |
| `monitoring`  | `DISCORD_WEBHOOK_MONITORING`  | Health flips, circuit breakers, payout failures, asset drift |
| `admin-audit` | `DISCORD_WEBHOOK_ADMIN_AUDIT` | Every admin-panel mutation (ADR 017 / 018)                   |

Full notifier catalogue: `DISCORD_NOTIFIERS` in `apps/backend/src/discord.ts`.

**Dedup and flap damping already in place** (this is what we accept
without a second tier):

- `HEALTH_NOTIFY_COOLDOWN_MS` — 30-min per-machine cooldown on
  `/health` degraded ↔ healthy flips (A2-1326 + the earlier flap-fix
  PR). Rolling-window detector absorbs one-off probe timeouts.
- `CIRCUIT_NOTIFY_DEDUP_MS` — 10-min per-(circuit, state) dedup.
  "login open" and "merchants open" throttle independently.
- Operator-pool exhaustion — once per `LOOP_POOL_EXHAUSTED_ALERT_INTERVAL_MS`
  (15 min default) per process.
- USDC-below-floor — once per `LOOP_BELOW_FLOOR_ALERT_INTERVAL_MS` per
  process.
- Asset-drift — in-memory per-asset dedupe at the watcher so ok→over
  fires once and over→ok fires once.

All dedup is **in-process** — a fleet of N machines has N independent
counters. Worst-case Discord rate is `N × (1 / dedup_window)` per
event type. On the configured single-machine Fly deployment, that's
simply the per-process rate.

## Limits we accept

1. **Discord itself is a single point of failure.** An outage on
   `discord.com` = ops is blind for the duration. Their availability
   is public (status.discord.com); we don't do anything about it.
2. **Operator attention is human.** At 3 am a `notifyPayoutFailed`
   embed might sit unread for hours.
3. **Channel noise vs actionable.** We've tuned the channel to
   emit only on state transitions or throttled thresholds, but a
   genuine compound incident (say: upstream outage + concurrent
   drift + several payout failures) will still produce 10+ embeds
   in quick succession. That's correct — we want the signal — but
   it means a human needs to triage.

## Phase-2 paging plan (not shipped in Phase 1)

When traffic justifies it, Loop introduces a **second, narrower
tier** for paging-grade signals. Candidates (narrow by design — we do
not want every notifier paging on-call):

- `notifyPayoutFailed` — user money stuck in-flight.
- `notifyAssetDrift` (over-minted) — ADR-015 safety-critical; blocks
  issuance until explained.
- `notifyOperatorPoolExhausted` — procurement can't proceed.
- `notifyHealthChange` `'degraded'` — only after the rolling window
  confirms; already heavily dedup'd.

### Options (not a commitment; ordered by implementation cost)

1. **PagerDuty integration** — webhook → PagerDuty service → on-call
   schedule → SMS / push / phone. PagerDuty has a free tier; fits
   the shape of our notifiers cleanly.
2. **OpsGenie** — same shape, different vendor.
3. **Twilio SMS direct** — we own the number, cheapest recurring
   cost, no on-call rotation logic. Good for a one-operator team.
4. **Apple Push / FCM** to the operator's mobile app — we already
   ship Loop on iOS + Android; an `/admin/alerts` push channel would
   piggyback the existing Capacitor integration. Viable when the
   mobile binary ships its alert-subscriber flow.

Scoping gate for adoption: the first time a 3 am outage goes unread
for more than `<LOOP_ALERT_RESPONSE_SLO>` (informal — see
`docs/slo.md`), prioritise one of the above.

## Wiring (when we ship the second tier)

Minimum shape:

- New env var pair, e.g. `PAGING_WEBHOOK_URL` + `PAGING_CHANNEL`.
- A new `notifyPaging(args)` in `apps/backend/src/discord.ts`
  sibling — same
  fire-and-forget contract, separate transport.
- Each paging-grade notifier calls both — `notifyPayoutFailed` fans
  out to `DISCORD_WEBHOOK_MONITORING` AND `PAGING_WEBHOOK_URL`.
- Absent the env var, the paging path is a silent no-op (same
  pattern as `DISCORD_WEBHOOK_ADMIN_AUDIT`).

An ADR captures the final choice of provider and the exact set of
notifiers in the paging tier. Phase 1 doesn't need it.

## Cross-reference

- `docs/slo.md` — pairs with this doc. SLO breaches are the
  threshold that would move a notifier into the paging tier.
- `apps/backend/src/discord.ts::DISCORD_NOTIFIERS` — live notifier
  catalogue. When a new notifier is added, decide its paging-tier
  eligibility at PR time and note the decision in the PR body.
