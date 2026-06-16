# Runbook — Data Subject Rights (DSR) request handling

**Covers:** CF-26 / X-PRIV-01 (in-app + operator-side data export and
account deletion), X-PRIV-02 (the off-DB log/Sentry/Discord export
fallback the privacy policy promises), and the auth-row retention purge
(CF-26 / X-PRIV-07/08).

**When this fires:** a user exercises a GDPR Art. 15 (access) / Art. 20
(portability) / Art. 17 (erasure) request — either self-serve in the
app, or by emailing `privacy@loopfinance.io`.

## Severity / SLA

**Not an alert.** GDPR allows up to **30 days** to respond. Acknowledge
within 5 business days; complete within 30. CCPA is similar. Treat an
Art. 17 (deletion) request as higher priority than a pure export.

---

## 1. Self-serve path (preferred — no operator action)

Most requests need **zero** operator involvement. The app exposes both
rights at **Account → Privacy & data** (`/settings/privacy`):

- **Download my data** → `GET /api/users/me/dsr/export` — a versioned
  JSON envelope of every DB row keyed to the user (profile, credit
  ledger, orders, payouts). Redeem codes/PINs are intentionally excluded
  (shown as a boolean only). Source: `apps/backend/src/users/dsr-export.ts`.
- **Delete my account** → `POST /api/users/me/dsr/delete` — anonymises
  the account (ADR-009 keeps the ledger append-only). Source:
  `apps/backend/src/users/dsr-delete.ts`.

If a user says "I can't find it / it didn't work", confirm they are on a
build that has the screen, then fall through to the operator paths below.

---

## 2. Operator-side export (Art. 15 / 20)

Run the same endpoint on the user's behalf with an admin/operator
session, or query the DB directly. The endpoint is the source of truth
for **what** to include; prefer it:

```bash
# As the user (if you have their bearer) — or replay the same SELECTs
# the export builder runs, keyed on user_id.
curl -sS -H "Authorization: Bearer <user-access-token>" \
  https://api.loopfinance.io/api/users/me/dsr/export > export-<user_id>.json
```

If you only have the email, resolve the `user_id` first:

```sql
SELECT id, email, created_at FROM users WHERE email = '<email>';
```

The tables the export covers: `users`, `user_identities`, `user_credits`,
`credit_transactions`, `orders`, `pending_payouts`.

### Off-DB data the endpoint cannot export (X-PRIV-02)

The privacy policy promises these via `privacy@loopfinance.io`. They live
**off-host** and require a manual pull — there is no self-serve endpoint:

| Source                | Where                       | Retention | How to pull                                                                                                                                       |
| --------------------- | --------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend access logs   | Fly logflow (Pino → stdout) | 14 days   | `flyctl logs -a loopfinance-api` filtered by the `X-Request-Id`s / `userId` in the time window. Email is logged by design (`docs/log-policy.md`). |
| Sentry events         | Sentry project              | 30 days   | Sentry UI → search `user.id:<user_id>`; PII is scrubbed (email/Bearer/Stellar/hex) so most events carry only the id.                              |
| Discord audit/monitor | Discord channels            | unbounded | Channel search; user/order ids are mostly `slice(-8)` truncated, so per-user extraction is best-effort.                                           |

Document what you pulled and email the combined package to the user.
Anything older than the retention window above is genuinely gone — say so.

---

## 3. Account deletion (Art. 17 — erasure)

Self-serve via `/settings/privacy`, or operator-driven via the same
endpoint. Deletion is **anonymisation**, not a hard delete (ADR-009): the
email is replaced with `deleted-{uuid}@deleted.loopfinance.io`,
`stellar_address` + `ctx_user_id` are nulled, OAuth identities are
deleted, all refresh tokens are revoked, and terminal payout
`to_address` rows are scrubbed. Ledger rows are retained (tax/regulatory)
but no longer link to a real person.

### The endpoint refuses with a typed 409 when

| Code                               | Meaning                                               | Resolution                                                                     |
| ---------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `PENDING_PAYOUTS`                  | a payout is `pending` / `submitted` (money in flight) | wait for it to settle, then retry                                              |
| `IN_FLIGHT_ORDERS`                 | an order is `pending_payment` / `paid` / `procuring`  | wait for it to fulfil or expire, then retry                                    |
| `FAILED_UNCOMPENSATED_WITHDRAWALS` | a `failed` withdrawal with `compensated_at IS NULL`   | the user owes themselves money — run admin compensation **first**, then delete |

If a request is stuck behind one of these, resolve the underlying state
(or have ops compensate the failed withdrawal) before re-running the
deletion. Never bypass the guard with a raw `UPDATE` — it exists to stop
orphaning money.

### Post-deletion

The user's session is dead immediately. A subsequent sign-in with the
original email creates a **fresh** account (the deleted row's email is
now the synthetic sentinel) with no access to the old, anonymised
history. Confirm completion back to the user.

---

## 4. Auth-row retention purge (X-PRIV-07/08)

Two PII-bearing tables — `otps` (email + code hash) and `refresh_tokens`
(token hash + user_id) — are swept of dead rows by the **auth-row purge**
worker (`apps/backend/src/auth/auth-row-purge.ts`), which runs under
`LOOP_WORKERS_ENABLED` every `LOOP_AUTH_ROW_PURGE_INTERVAL_HOURS` (1h
default) and deletes rows past `LOOP_AUTH_ROW_RETENTION_DAYS` (30d
default). This is automatic retention hygiene — **not** part of a DSR
delete (that path revokes a user's refresh tokens directly).

If you need to reclaim immediately (e.g. workers are off in Phase-1 and a
table has grown), run the one-shot tick against a maintenance session:

```ts
// tsx one-liner against the deployed DATABASE_URL, or via a scratch
// REPL importing the worker module.
import { runAuthRowPurgeTick } from './apps/backend/src/auth/auth-row-purge.js';
await runAuthRowPurgeTick(); // uses LOOP_AUTH_ROW_RETENTION_DAYS
```

Or a direct SQL sweep mirroring the worker (same predicates):

```sql
-- Expired/consumed OTPs past the 30-day grace.
DELETE FROM otps WHERE expires_at < now() - interval '30 days';

-- Dead (expired OR long-revoked) refresh tokens past the grace.
DELETE FROM refresh_tokens
 WHERE expires_at < now() - interval '30 days'
    OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days');
```

Never delete rows inside the retention grace — a just-rotated refresh
token still needs to trip the token-theft reuse signal (A2-1608), and a
just-expired OTP still needs to return the normal 401.

---

## Related

- `docs/log-policy.md` — what's logged + redacted, retention windows, RBAC.
- `docs/adr/009-credits-ledger-cashback-flow.md` — why erasure is anonymisation.
- `apps/backend/src/users/dsr-export.ts` / `dsr-delete.ts` — the primitives.
- `apps/web/app/routes/settings.privacy.tsx` — the in-app surface.
