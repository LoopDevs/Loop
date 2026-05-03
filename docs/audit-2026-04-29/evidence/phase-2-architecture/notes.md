# Phase 2 — Architecture & ADR Truth

- Capture date: 2026-04-29
- Commit audited: `761107214e436613a7fbbe4e91e82d197c521f71`
- Auditor: Codex
- Phase status: in-progress

## Evidence

- Auth documentation drift capture: [artifacts/auth-doc-drift.txt](./artifacts/auth-doc-drift.txt)

## Findings logged

- `A3-003` Medium — `docs/architecture.md` still documents a proxy-only auth system and says the backend does not mint its own tokens, while root `AGENTS.md` documents dual-path auth with Loop-native JWT minting behind `LOOP_AUTH_NATIVE_ENABLED`.

## Notes

- This is a material trust-boundary drift, not a cosmetic wording issue: it changes how reviewers reason about token issuance, verification, and auth-path testing.
