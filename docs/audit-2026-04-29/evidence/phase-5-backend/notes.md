# Phase 5 — Backend Request Surface

- Capture date: 2026-04-29
- Commit audited: `761107214e436613a7fbbe4e91e82d197c521f71`
- Auditors: Codex, worker `Harvey`
- Phase status: in-progress

## Findings logged

- `A3-015` Critical — admin auth is locally bypassable with a forged JWT-like bearer on the legacy CTX path.
- `A3-016` Medium — the bearer-gated `/openapi.json` response is cacheable without `Vary: Authorization`, so a shared cache can leak the admin-inclusive spec.

## Notes

- Additional OpenAPI/auth drift found in this pass is recorded under the phase-14 contract-truth findings rather than duplicated here.
