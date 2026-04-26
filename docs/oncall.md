# On-call, incident response, status comms

This is the source of truth for **who responds**, **how fast**, **what
template they use**, and **what the customer sees**. Pinned by
A2-1901 (no on-call roster), A2-1902 (no incident SLA / template /
post-mortem policy), A2-1903 (no status page / customer comms).

## On-call roster (A2-1901)

Loop is a two-maintainer project pre-launch. The on-call rotation is
**weekly, alternating** between the two maintainers — published in
the team calendar, with the next 4 weeks always visible.

| Week             | Primary      | Secondary    |
| ---------------- | ------------ | ------------ |
| Cycle definition | Maintainer A | Maintainer B |
| Cycle definition | Maintainer B | Maintainer A |

The **primary** is the first responder. The **secondary** is the
escalation path if primary doesn't acknowledge a P0 within the SLA
window below.

**Hand-off Mondays at 09:00 UK time.** The outgoing primary posts an
"incoming" thread in `#deployments` with: any open incidents, any
in-flight deploys to watch, any cert/secret expiry inside the window.
The new primary acknowledges before the channel goes quiet.

The roster file lives at `docs/oncall-roster.md` (gitignored —
contains personal contact handles). Reference, not source — the
team calendar is the authoritative schedule, the roster file is the
contact-info side.

## Severity tiers + response SLA (A2-1902)

| Severity | Definition                                                                                                           | Ack    | Mitigate | Resolve     |
| -------- | -------------------------------------------------------------------------------------------------------------------- | ------ | -------- | ----------- |
| **P0**   | Customer-facing flow broken (orders, auth, payouts) OR money-flow correctness incident OR active security compromise | 5 min  | 30 min   | 4 h         |
| **P1**   | Partial degradation — one surface/region down, OR rolling failure not yet customer-noticed                           | 15 min | 1 h      | 24 h        |
| **P2**   | Single user-class affected, single stuck row, single-entity drift                                                    | 1 h    | 8 h      | 1 week      |
| **P3**   | Cosmetic / log-only / policy drift                                                                                   | 1 day  | n/a      | next sprint |

**Ack** = "I see it, I own it, I'm starting work." Posted in
`#ops-alerts` as a reply to the alert.

**Mitigate** = stop the bleed. May or may not be the root-cause fix.
For most incidents the targeted runbook (`docs/runbooks/`) is the
mitigation; the resolve step is the fix-forward / rollback / migration.

**Resolve** = root cause addressed, no further customer impact, all
state reconciled.

If primary doesn't ack within the SLA, secondary is auto-paged via
the calendar's escalation rule (currently a manual phone call;
PagerDuty integration is a Phase-2 deferral).

## Incident-response template (A2-1902)

Open as a Discord forum post in `#incidents` (channel TBD; use
`#deployments` thread until then). Title: `INC-YYYY-MM-DD-<slug>`.

```markdown
**Severity:** P0 / P1 / P2 / P3
**Owner:** @<primary-on-call>
**Detected:** <timestamp> via <alert | customer report | rehearsal>
**Status:** investigating / mitigated / resolved

## Timeline

- HH:MM — alert fires / customer report
- HH:MM — owner acks
- HH:MM — diagnosis: <runbook link if applicable>
- HH:MM — mitigation deployed: <PR / fly deploy / kill-switch>
- HH:MM — resolved

## Customer impact

<count of users affected, what they saw, surface, dollars if money-flow>

## Root cause

<the actual underlying cause once known>

## Follow-up

- [ ] <runbook update if the runbook was wrong>
- [ ] <test / monitor that would have caught this earlier>
- [ ] <ticket links for fix-forward work>
```

## Post-mortem policy (A2-1902)

**Required for every P0 and P1.** Optional but encouraged for P2
that recurred or took longer than the SLA.

The post-mortem is posted in `#deployments` within **5 business
days** of resolve, using the template above with the timeline +
root-cause + follow-up sections fleshed out. Owner of the original
incident is owner of the post-mortem unless they hand it off
explicitly.

Post-mortems are **blameless**. Document what happened, what was
believed at each step, and what the system needs to look like so
this class of failure self-mitigates next time. No "X should have
known" lines.

## Customer-facing comms (A2-1903)

Phase-1 posture: **lightweight status comms, not a status page.**

| Surface             | When                                          | Channel                                                        |
| ------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| Active P0 incident  | Within 15 min of mitigation start             | In-app banner via web/mobile config flag (Phase-2 — see below) |
| Resolved P0         | Within 1h of resolution                       | Loop blog post + a tweet from `@loopfinance`                   |
| Planned maintenance | 24h advance                                   | Email to all users + in-app banner                             |
| Ongoing degradation | If >30 min, post update every 30 min          | Twitter / X                                                    |
| Security disclosure | Per `SECURITY.md` — coordinated with reporter | GitHub Security Advisory                                       |

**No public status page in Phase 1.** Loop's user base is small
enough at launch that direct email + in-app banner reach the user
faster than `status.loopfinance.io` would. A status page lands in
Phase 2 alongside the staging environment (A2-1913) and the
external log sink (A2-1911).

**The in-app banner uses a runtime config flag** that operators
can toggle via Fly secret without a redeploy (cf. A2-1907 kill
switches). Banner copy is plain text + an optional href; the flag
shape:

```bash
fly secrets set LOOP_INCIDENT_BANNER='{"text":"Investigating elevated payout latency","href":"https://twitter.com/loopfinance/status/..."}' -a loop-web
```

The web app reads the flag on every page load (no caching) so the
ack-to-banner-up window is single-digit-seconds.

The exact banner-flag implementation is a separate ticket — this
policy doc commits to the contract; the implementation lands when
the first P0 actually needs it (skin-in-the-game over speculative
infra).

## Phase-2 deferrals

- PagerDuty / phone-tree integration. Today's manual ack via Discord
  is acceptable for two maintainers.
- Public status page at `status.loopfinance.io`.
- Customer-segmented incident comms (e.g. only ping users in the
  affected region).

## When this doc updates

- New severity tier or different SLA windows → ADR-required.
- New post-mortem template field → in-PR with the first incident
  that needed it.
- New customer-comms surface (e.g. status page goes live) → in-PR
  with the wiring.

## References

- `docs/runbooks/` — the per-surface diagnosis + mitigation runbooks
  the on-call uses.
- `docs/alerting.md` — Phase-1 Discord-only alerting, with the
  paging tiers this doc maps to (A2-1327).
- `docs/log-policy.md` — what the on-call can read while debugging
  (A2-1911).
- `SECURITY.md` — security incidents have their own disclosure flow.
