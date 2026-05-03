# Phase 13 — Mobile & Native Bridges

- Capture date: 2026-04-29
- Commit audited: `761107214e436613a7fbbe4e91e82d197c521f71`
- Auditors: Codex, worker `Noether`
- Phase status: in-progress

## Findings logged

- `A3-009` Medium — overlay-enforced native hardening is still a manual post-`cap sync` step, so security-sensitive mobile config can regress silently on any machine that forgets to reapply it.
- `A3-010` Medium — the app-lock flow fails open when biometrics become unavailable.
- `A3-011` Low — privacy-screen protection is weaker than the feature names suggest on already-open sessions, especially on Android task-switcher capture.

## Notes

- Native secure-storage handling looked sound on this first pass.
- Plugin dependency parity between `apps/web` and `apps/mobile` looked aligned in tracked manifests.
