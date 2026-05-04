# Phase 11 - Data Layer and Migrations

Status: complete
Owner: lead (Claude)

## Files reviewed

- apps/backend/src/db/{schema,client,users}.ts
- apps/backend/src/db/migrations/0000-0028 (29 SQL files)
- apps/backend/src/db/migrations/meta/\_journal.json
- apps/backend/src/migrate-cli.ts
- apps/backend/src/scripts/check-ledger-invariant.ts

## Findings filed

- A4-024 Medium — cashback-config audit trigger fires only on UPDATE
- A4-027 Low — pending_payouts.asset_code/asset_issuer have no DB CHECK
- A4-028 Low — credit_transactions.reason has no length CHECK
- A4-030 Low — orders.charge_minor schema-vs-migration drift on DEFAULT
- A4-031 Low — migrations 0013/0017/0018/0022/0024/0025 lack `IF NOT EXISTS` idempotency

## No-finding-but-reviewed

- Composite PK on (user_id, currency) for user_credits.
- Partial unique indexes guard idempotency: orders_user_idempotency_unique, credit_transactions_reference_unique, credit_transactions_interest_period_unique, pending_payouts_active_withdrawal_unique, pending_payouts_order_unique, refresh_tokens by jti, social_id_token_uses by token-hash.
- CHECK constraints on currency, state, payment_method, kind, address shape, percentages sum.
- Migration journal entries match SQL file inventory 0000-0028.
