# Staff role revocation (ADR 037)

How to remove (or downgrade) a staff member's access, and what the
revocation does NOT immediately cover.

## Normal path

`DELETE /api/admin/staff/:userId/role` (or `PUT … { role: 'support' }`
to downgrade) from the role-management view. Admin-only, step-up
gated, full ADR 017 envelope (Idempotency-Key + reason + Discord
audit in `#admin-audit`).

Guards you may hit:

- `STAFF_SELF_REVOKE` (409) — you cannot revoke/demote yourself;
  another admin must do it.
- `STAFF_LAST_ADMIN` (409) — the target is the final effective
  admin; grant someone else `admin` first.

## The 15-minute token window

`requireStaff` resolves the role per request from `staff_roles`, but
access tokens live for up to 15 minutes and are not revoked by a
role change — same semantics the `users.is_admin` model had. A
revoked staff member's _next_ request after the row changes is
denied (the role is re-read every request), so in practice the
window is one request, not 15 minutes — but do not treat revocation
as instantaneous session kill. For a hostile-departure scenario,
also rotate `LOOP_JWT_SIGNING_KEY` (see `jwt-key-rotation.md`).

## CTX-allowlist admins (legacy shim)

`users.is_admin` is still recomputed from `ADMIN_CTX_USER_IDS` on
every CTX-path upsert (ADR 013). The role writes mirror the flag,
but for a user present in that env allowlist the next CTX-anchored
login flips `is_admin` back to true and the legacy shim
(`requireStaff` fallback when no `staff_roles` row exists) would
re-admit them. **Revoking a CTX-allowlist admin therefore requires
BOTH** the `DELETE /api/admin/staff/:userId/role` write **and**
removing their CTX user id from `ADMIN_CTX_USER_IDS`
(`flyctl secrets set ADMIN_CTX_USER_IDS=…` + restart).

Note the row-wins rule: while a `staff_roles` row exists it
overrides the shim, so a demote-to-support row keeps them at
support even if `is_admin` gets re-flagged — full revocation
(row deleted) is the case that needs the env edit.

## Verification

1. `GET /api/admin/staff` no longer lists the user (or lists the
   new role).
2. As the revoked user (or via their report), any `/api/admin/*`
   call returns 404.
3. The Discord `#admin-audit` entry exists with the reason.
