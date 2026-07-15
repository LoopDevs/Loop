# Wave6 remediation — deploy runbook (2026-07)

The wave6 audit remediation (PR #1665, merged `131d598c`) added migrations `0064`–`0070`
plus the NS-10 mandatory redeem-encryption change. This is what a deploy needs.

**Context: Loop has no production traffic yet.** That removes almost all risk — the
constraint/trigger migrations have no live writes to reject and no drifted data to trip on.

## 1. Migrations — apply automatically on deploy (nothing manual)

`apps/backend/fly.toml` runs them as the release command:

```
[deploy]
  release_command = "node apps/backend/dist/migrate-cli.js"   # -> runMigrations() (drizzle)
```

On the next `fly deploy`, the full `0000`→`0070` chain applies before the new version goes
live; if any migration fails the release aborts (exit 1) and the old version keeps running.

The chain is proven to replay cleanly into a fresh DB by every `npm run check:migration-parity`
run (625 catalog entries match). Apply-time behavior per new migration:

| Migration                           | What it does at apply time              | Validates existing rows?                                                                          |
| ----------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 0064 ledger immutability            | creates BEFORE UPDATE/DELETE triggers   | no (metadata only)                                                                                |
| 0065 step-up consumptions           | creates a new table                     | no                                                                                                |
| 0066 balance/ledger mirror          | creates a DEFERRABLE constraint trigger | no (fires on future writes only)                                                                  |
| 0067 cashback/interest conservation | creates a BEFORE INSERT trigger         | no (future writes only)                                                                           |
| 0068 orders CHECKs                  | `ADD CONSTRAINT` (immediate)            | **YES** — fails if any orders row has negative pct or face_value ≤ 0 (none exist with no traffic) |
| 0069 hot-float carry_stroops        | adds a column (NOT NULL DEFAULT 0)      | no (metadata only)                                                                                |
| 0070 users.token_version            | adds a column (NOT NULL DEFAULT 0)      | no (metadata only)                                                                                |

## 2. HARD PREREQUISITE — set `LOOP_REDEEM_ENCRYPTION_KEY` before deploying

NS-10 makes the backend **fail closed at boot in production** when
`LOOP_REDEEM_ENCRYPTION_KEY` is unset. `migrate-cli` parses the same env, so **the release
command itself aborts without the key** — the deploy will not proceed.

```
# generate a 32-byte key and set it as a Fly secret BEFORE the deploy:
fly secrets set LOOP_REDEEM_ENCRYPTION_KEY="$(openssl rand -base64 32)" -a <backend-app>
```

(Escape hatch, not recommended: `DISABLE_REDEEM_ENCRYPTION_ENFORCEMENT=1` boots with plaintext
at rest — only for a deliberate, audited exception.)

## 3. Redeem backfill — one-shot, only if legacy plaintext exists

`apps/backend/src/scripts/backfill-redeem-encryption.ts` encrypts any pre-existing plaintext
`orders.redeem_code` / `redeem_pin`. It is **not** part of the release command. It is
idempotent, batched, `--dry-run`-capable, and refuses to run without the key.

```
# after the deploy, with the full prod env available (e.g. `fly ssh console`):
node apps/backend/dist/scripts/backfill-redeem-encryption.js --dry-run   # see what it would do
node apps/backend/dist/scripts/backfill-redeem-encryption.js             # do it
```

With no production traffic there are no plaintext rows → it's a no-op. Run it anyway to confirm.

## 4. Ledger reconciliation — confirm zero drift (matters once writes resume)

`apps/backend/src/scripts/check-ledger-invariant.ts` reports any `(user, currency)` whose
`user_credits.balance_minor` ≠ `SUM(credit_transactions.amount_minor)`. If it's ever non-empty,
the `0066` mirror trigger will reject that user's next write. On empty/clean data it exits 0.

```
node apps/backend/dist/scripts/check-ledger-invariant.js   # exit 0 = consistent
```

Because `0066` only fires on _future_ writes, applying it is always safe; keep this green so a
legitimate write is never rejected once real usage starts.

## Summary (no-traffic deploy)

1. `fly secrets set LOOP_REDEEM_ENCRYPTION_KEY=…`
2. `fly deploy` — migrations auto-apply via the release command.
3. `check-ledger-invariant` → exit 0 (trivially clean while empty).
4. `backfill-redeem-encryption` → no-op (no plaintext yet).

All migration/backfill/reconciliation code is panel-verified with DB-backed tests; running them
against real infra is the only step not performed during remediation.
