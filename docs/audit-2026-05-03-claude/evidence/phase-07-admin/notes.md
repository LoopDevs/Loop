# Phase 07 - Admin Surface and Operator Controls

Status: complete
Owner: lead (Claude)

## Files reviewed

- apps/backend/src/admin/\* (~110 handlers + helpers)
- apps/backend/src/routes/admin\*.ts (12 mount factories)
- apps/backend/src/openapi/admin\*.ts
- apps/backend/src/auth/require-admin.ts
- apps/backend/src/**tests**/integration/admin-writes.test.ts
- apps/web/app/services/admin\*.ts (35 admin service modules)
- apps/web/app/components/features/admin/\* (selected: CreditAdjustmentForm, AdminWithdrawalForm, ReplayedBadge, MerchantResyncButton, RetryPayoutButton, DiscordNotifiersCard)

## Findings filed

- A4-003 Low — payout retry not advisory-locked
- A4-011 Medium — withIdempotencyGuard ignores body content; key reuse with different body silently replays
- A4-019 High — refund handler skips withIdempotencyGuard
- A4-032 Medium — refund storeIdempotencyKey error swallowed; retry path broken
- A4-052 High — credit adjustment form has no confirmation dialog
- A4-053 High — withdrawal form has no confirmation dialog

## No-finding-but-reviewed

- requireAdmin closes 404 on non-admin (no leakage).
- ADR-017 audit envelope shape is consistent across credit-adjustment + refund + withdrawal + payout-retry + payout-compensation.
- Read-audit middleware logs every admin GET; CSV downloads + bulk reads also fire Discord ping.
- Daily admin adjustment cap enforced via advisory-locked SQL aggregate (`credits/adjustments.ts`).

## Cross-references

- Phase 12 owns financial-invariant findings on payout-compensation (A4-020/A4-021/A4-022).
- Phase 24 owns A4-063 (step-up auth absent).
