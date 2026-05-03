# Phase 14 — Shared Contracts & Serialization

- Capture date: 2026-04-29
- Commit audited: `761107214e436613a7fbbe4e91e82d197c521f71`
- Auditors: Codex, worker `Carver`
- Phase status: in-progress

## Findings logged

- `A3-012` High — runtime error codes have drifted out of the shared/OpenAPI/docs contract.
- `A3-013` High — the OpenAPI auth narrative is materially false for the current dual-path backend.
- `A3-014` Medium — `POST /api/auth/request-otp` is misregistered in OpenAPI around 503 behavior and error code.

## Notes

- No obvious `packages/shared` barrel/export gap surfaced on this pass.
- The dominant failure mode here is contract truth drift across backend runtime, shared enum, OpenAPI registration, and docs.
