# Loop — Cold Adversarial Audit (2026-04) — Tracker

> Source of truth for audit status. See [`audit-2026-adversarial-plan.md`](./audit-2026-adversarial-plan.md) for the plan.
>
> **This tracker is live-updated during execution.** The plan is frozen; this tracker is the state.

## Plain-English summary (written last, per plan G3-15)

_To be written after Phase 19 synthesis. Do not pre-populate._

---

## Index

### Finding counts (by severity)

| Severity  | Count |
| --------- | ----- |
| Critical  | 0     |
| High      | 0     |
| Medium    | 1     |
| Low       | 3     |
| Info      | 0     |
| **Total** | **4** |

### Finding counts (by status)

| Status      | Count |
| ----------- | ----- |
| open        | 4     |
| in-progress | 0     |
| resolved    | 0     |
| accepted    | 0     |
| wontfix     | 0     |
| deferred    | 0     |

### Phase progress

Plan has 20 phases (0–19 plus 6.5). Progress updated as each phase exits.

| Phase | Title                           | Status      | Audited-by | Reviewed-by | Evidence                                                           | Findings (C/H/M/L/I) |
| ----- | ------------------------------- | ----------- | ---------- | ----------- | ------------------------------------------------------------------ | -------------------- |
| 0     | Inventory                       | ✅ complete | claude     | pending     | [phase-0-inventory.md](./audit-2026-evidence/phase-0-inventory.md) | 0/0/1/3/0            |
| 1     | Governance & Repo Hygiene       | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 2     | Architecture compliance         | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 3     | Dependencies & Supply chain     | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 4     | Build & release reproducibility | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 5     | Backend per-module audit        | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 6     | Database & Data Layer           | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 6.5   | Financial Correctness           | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 7     | API surface                     | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 8     | Web per-module audit            | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 9     | Mobile shell                    | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 10    | Shared package                  | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 11    | Cross-app integration           | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 12    | Security deep-dive              | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 13    | Observability                   | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 14    | Testing                         | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 15    | Documentation                   | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 16    | CI/CD & Automation              | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 17    | Operational readiness           | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 18    | Adversarial / Red-team          | open        | —          | —           | —                                                                  | 0/0/0/0/0            |
| 19    | Synthesis & sign-off            | open        | —          | —           | —                                                                  | 0/0/0/0/0            |

---

## Findings

Findings are recorded below their owning phase. Each finding follows the shape from plan §3.3.

### Phase 0 — Inventory

Complete. Evidence: [phase-0-inventory.md](./audit-2026-evidence/phase-0-inventory.md). Commit SHA at capture: `84fc581`.

#### A2-001 — Favicon files are 0 bytes

| Field       | Value                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity    | **Medium**                                                                                                                                                                                              |
| Status      | open                                                                                                                                                                                                    |
| Files       | `apps/web/public/loop-favicon.ico` (0B), `apps/web/public/loop-favicon.png` (0B), referenced from `apps/web/app/root.tsx:135-136`                                                                       |
| Evidence    | `wc -c` on the two files returns `0`. `root.tsx` emits `<link rel="icon" href="/loop-favicon.ico">` and `<link rel="icon" type="image/png" href="/loop-favicon.png">`.                                  |
| Impact      | Browsers fetching the favicon receive an empty response. Tab icon is blank / generic. User-facing polish defect; not a security issue.                                                                  |
| Remediation | Replace both files with actual favicon binaries exported from `loop-favicon.svg` (which is non-empty), or remove the `<link>` entries and keep only the SVG favicon (supported by all modern browsers). |
| Owner       | _unassigned_                                                                                                                                                                                            |

#### A2-002 — Unreferenced root-level `looplogo.svg` is a duplicate

| Field       | Value                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity    | **Low**                                                                                                                                                                                                 |
| Status      | open                                                                                                                                                                                                    |
| Files       | `looplogo.svg` (repo root, 1572 bytes)                                                                                                                                                                  |
| Evidence    | `sha256sum looplogo.svg apps/web/public/loop-logo.svg` → identical hash `a38062762e6d...`. `grep -rn looplogo.svg` across `apps/`, `docs/`, `scripts/`, top-level `.md`/`.ts` files returns no matches. |
| Impact      | Dead file. Confusing during editing (which logo is canonical?).                                                                                                                                         |
| Remediation | Delete `looplogo.svg`.                                                                                                                                                                                  |
| Owner       | _unassigned_                                                                                                                                                                                            |

#### A2-003 — Duplicate PNG logos not referenced from web source

| Field       | Value                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity    | **Low**                                                                                                                                                                                                                   |
| Status      | open                                                                                                                                                                                                                      |
| Files       | `apps/web/public/loop-logo.png` (19259B), `apps/web/public/loop-logo-square.png` (19259B)                                                                                                                                 |
| Evidence    | `shasum -a 256` on both files → identical hash `2e3aaa10d321...`. Scoped grep through `apps/web/app/**/*.{ts,tsx,css}` returns zero references (only matches are Android build artifacts that are themselves gitignored). |
| Impact      | Two files' worth of dead static-asset payload shipped with the web build.                                                                                                                                                 |
| Remediation | Delete both unless intentionally kept as a public URL consumed outside the app (e.g. og:image for a specific path — confirm with owner before deleting).                                                                  |
| Owner       | _unassigned_                                                                                                                                                                                                              |

#### A2-004 — `loop-favicon.svg` has content but no reference

| Field       | Value                                                                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity    | **Low**                                                                                                                                                                                                                                       |
| Status      | open                                                                                                                                                                                                                                          |
| Files       | `apps/web/public/loop-favicon.svg` (234 bytes)                                                                                                                                                                                                |
| Evidence    | `grep -rn loop-favicon.svg apps/` returns no reference from application code (only build artifacts). `root.tsx:135-136` links `.ico` and `.png` but not the `.svg`.                                                                           |
| Impact      | An intended SVG favicon that was never wired up. Either the file is stale or `root.tsx` is incomplete. Ties in with A2-001 — the SVG may be the fix for A2-001.                                                                               |
| Remediation | Add `<link rel="icon" type="image/svg+xml" href="/loop-favicon.svg">` to `root.tsx` alongside the raster fallbacks (preferred modern pattern), **or** delete the file if it's no longer intended. Decision depends on how A2-001 is resolved. |
| Owner       | _unassigned_                                                                                                                                                                                                                                  |

### Phase 1 — Governance

_Phase not started._

### Phase 2 — Architecture compliance

_Phase not started._

### Phase 3 — Dependencies & Supply chain

_Phase not started._

### Phase 4 — Build & release

_Phase not started._

### Phase 5 — Backend per-module

_Phase not started._

### Phase 6 — Data Layer

_Phase not started._

### Phase 6.5 — Financial Correctness

_Phase not started._

### Phase 7 — API surface

_Phase not started._

### Phase 8 — Web per-module

_Phase not started._

### Phase 9 — Mobile shell

_Phase not started._

### Phase 10 — Shared package

_Phase not started._

### Phase 11 — Cross-app integration

_Phase not started._

### Phase 12 — Security deep-dive

_Phase not started._

### Phase 13 — Observability

_Phase not started._

### Phase 14 — Testing

_Phase not started._

### Phase 15 — Documentation

_Phase not started._

### Phase 16 — CI/CD & Automation

_Phase not started._

### Phase 17 — Operational readiness

_Phase not started._

### Phase 18 — Adversarial / Red-team

_Phase not started._

### Phase 19 — Synthesis & sign-off

_Phase not started._

---

## Residual risk register

_Populated at sign-off with any `accepted` findings + explicit residuals._

---

## Sign-off

| Field              | Value                                       |
| ------------------ | ------------------------------------------- |
| Audited commit SHA | _TBD_                                       |
| Sign-off date      | _TBD_                                       |
| Signers            | _TBD_                                       |
| Two-person rule    | per plan §G5-128 — TBD which policy applies |

_This section is filled in only after Phase 19 completes and the sign-off checklist (plan §9) is fully green._
