# Phase 16 — Testing & Regression Confidence

- Capture date: 2026-04-29
- Commit audited: `761107214e436613a7fbbe4e91e82d197c521f71`
- Auditors: Codex, worker `Helmholtz`
- Phase status: in-progress

## Findings logged

- `A3-018` Medium — web route coverage is overstated relative to the combination of unit and Playwright coverage that actually runs.
- `A3-019` Medium — the blocking test ladder does not exercise the admin money-write races most likely to hide behind green CI.
- `A3-027` Medium — the mocked e2e gate stays green while the homepage emits SSR hydration mismatches on the SSR web path.

## Notes

- The main CI workflow remains disciplined in token scope and action pinning.
- The issue here is coverage realism, not absence of automation.
