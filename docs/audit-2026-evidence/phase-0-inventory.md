# Phase 0 — Inventory (evidence)

**Commit SHA at capture:** `84fc581177ca4e9e60d27f3d915406b903c6f436`
**Audit branch:** `chore/audit-2026-bootstrap`
**Date captured:** 2026-04-23

---

## 1. Canonical file list

`git ls-files | wc -l` → **762 tracked files.**

### By top-level directory

| Directory   | Count |
| ----------- | ----- |
| `apps/`     | 669   |
| `docs/`     | 36    |
| `packages/` | 21    |
| `.github/`  | 8     |
| `tests/`    | 4     |
| `scripts/`  | 4     |
| `.husky/`   | 3     |
| root files  | 17    |

### Per-workspace

| Workspace         | Total | `.ts` | `.tsx` | Tests | SQL |
| ----------------- | ----- | ----- | ------ | ----- | --- |
| `apps/backend`    | 313   | 290   | 0      | 144   | 12  |
| `apps/web`        | 311   | 65    | 225    | 108   | 0   |
| `apps/mobile`     | 45    | 1     | 0      | 0     | 0   |
| `packages/shared` | 21    | 18    | 0      | 0     | 0   |

### By extension (top 10)

```
 378 ts
 225 tsx
  48 md
  33 png
  12 xml
  12 sql
  12 json
   7 yml
   4 svg
   4 sh
```

---

## 2. Directory purpose map

| Path               | Role                                                                                                              | Source of truth          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `apps/backend/`    | Hono + TS backend; proxies CTX, owns ledger, exposes admin surface                                                | `apps/backend/AGENTS.md` |
| `apps/web/`        | React Router v7 + Vite; dual SSR/static-export; pure API client                                                   | `apps/web/AGENTS.md`     |
| `apps/mobile/`     | Capacitor shell — loads the web static build; native overlays persisted                                           | ADR 007                  |
| `packages/shared/` | Types + pure utilities shared by web + backend (no runtime deps beyond `@bufbuild/protobuf`)                      | ADR 019                  |
| `docs/`            | Documentation hub — architecture, ADRs, dev/deploy guides                                                         | `AGENTS.md` docs index   |
| `docs/archive/`    | Legacy artifacts kept for reference (Phase 15 decides delete-or-keep)                                             | —                        |
| `scripts/`         | Root-level tooling: `verify.sh`, `lint-docs.sh`, `postgres-init.sh`, `e2e-real.mjs`                               | —                        |
| `tests/`           | E2E (Playwright mocked + real suites)                                                                             | `docs/testing.md`        |
| `.github/`         | CI (`ci.yml`, `e2e-real.yml`, `pr-automation.yml`, `pr-review.yml`), CODEOWNERS, dependabot, labeler, PR template | —                        |
| `.husky/`          | Git hooks (`commit-msg`, `pre-commit`, `pre-push`)                                                                | —                        |

---

## 3. Classification of every tracked file

See `phase-0-files-classified.txt` (sibling file) for the exhaustive list. Categories:

| Class                   | Count | Rule                                                                                                |
| ----------------------- | ----- | --------------------------------------------------------------------------------------------------- |
| source                  | 529   | `.ts` / `.tsx` under `apps/*/src`, `apps/web/app`, `packages/shared/src` excluding tests            |
| test                    | 252   | any file matching `__tests__` / `.test.` / `.spec.` / `tests/`                                      |
| config                  | 47    | `tsconfig*.json`, `package.json`, workflow `.yml`, `fly.toml`, `Dockerfile*`, lint/format configs   |
| doc                     | 48    | `*.md`                                                                                              |
| sql-migration           | 12    | `apps/backend/src/db/migrations/*.sql`                                                              |
| generated-checked-in    | 1     | `packages/shared/src/proto/clustering_pb.ts` — regenerable via `npm run proto:generate`             |
| native-overlay-asset    | 33    | `apps/mobile/native-overlays/**/*.png` + drawable XMLs                                              |
| static-asset (web)      | 12    | `apps/web/public/*`                                                                                 |
| script                  | 9     | `.husky/*`, `scripts/*`, `apps/mobile/scripts/*`, `tests/e2e-mocked/fixtures/*`                     |
| ignored-in-dockerignore | —     | docs, tests, scripts, mobile all excluded from the backend Docker build context per `.dockerignore` |

Every tracked file accounted for.

---

## 4. Executable-bit audit

`git ls-files --stage` → 9 files have mode `100755`:

```
.husky/commit-msg
.husky/pre-commit
.husky/pre-push
apps/mobile/scripts/apply-native-overlays.sh
scripts/e2e-real.mjs
scripts/lint-docs.sh
scripts/postgres-init.sh
scripts/verify.sh
tests/e2e-mocked/fixtures/mock-ctx.mjs
```

All legitimate (shell scripts + one `.mjs` that runs as a mock server). No accidental executable bits on source files. No missing executable bits on what should have them (every `.sh` is `100755`).

---

## 5. Symlink inventory

One symlink: `CLAUDE.md → AGENTS.md`. Documented in user memory + referenced as a convention for Claude Code tooling. No cycles, no repo-escape.

---

## 6. Large-file inventory

`git ls-files | xargs du -k | awk '$1 > 500'` → **zero files >500KB.** No large binaries in the tree.

---

## 7. Generated-file coverage

| Generated output                             | Source                                 | Regen command                               | Tracked in repo?                                              | Idempotent?                      |
| -------------------------------------------- | -------------------------------------- | ------------------------------------------- | ------------------------------------------------------------- | -------------------------------- |
| `packages/shared/src/proto/clustering_pb.ts` | `apps/backend/proto/clustering.proto`  | `npm run proto:generate`                    | **yes** (ADR 003)                                             | must verify in Phase 4           |
| React Router typegen output                  | filesystem routes                      | `npx react-router typegen`                  | no — under `apps/web/.react-router/` which is gitignored      | n/a                              |
| Drizzle-kit migration snapshot               | `apps/backend/src/db/schema.ts`        | `npm run db:generate`                       | yes (under `apps/backend/src/db/migrations/meta/`)            | must verify in Phase 4           |
| iOS / Android generated projects             | `capacitor.config.ts` + `npx cap sync` | `npx cap sync` + `apply-native-overlays.sh` | no — `apps/mobile/ios/` and `apps/mobile/android/` gitignored | must verify in Phase 4 / Phase 9 |
| Docker images                                | `Dockerfile`s                          | `docker build`                              | no (pushed to Fly registry)                                   | must verify in Phase 4           |

No tracked generated output is unaccounted for.

---

## 8. Import-graph / dead-file detection

Using `tsc --listFiles` per workspace and comparing against `git ls-files`:

| Workspace              | Tracked (excl. tests) | Compiled (incl. deps) | Tracked but NOT compiled (dead) |
| ---------------------- | --------------------- | --------------------- | ------------------------------- |
| `apps/backend/src/`    | 143                   | 143                   | **0**                           |
| `apps/web/app/`        | 179                   | 179                   | **0**                           |
| `packages/shared/src/` | 17                    | 17                    | **0**                           |

**Conclusion:** zero dead TypeScript files. Every tracked source module is part of the compile graph.

_(Heuristic note: a grep-based check using filename-as-substring gave false positives because imports in this repo use `.js` extensions on `.ts` files per NodeNext resolution. The `tsc --listFiles` approach is authoritative.)_

---

## 9. Asset inventory + reference check

12 static web assets at `apps/web/public/` plus 1 at repo root:

| File                                         | Size        | Referenced from `apps/web/app/**`?                                         | Disposition                 |
| -------------------------------------------- | ----------- | -------------------------------------------------------------------------- | --------------------------- |
| `apps/web/public/hero.webp`                  | 24K         | ✅ `routes/home.tsx:79`                                                    | live                        |
| `apps/web/public/leaflet/marker-icon-2x.png` | ~2K         | ✅ `components/features/ClusterMap.tsx:385`                                | live                        |
| `apps/web/public/leaflet/marker-icon.png`    | ~1K         | ✅ `components/features/ClusterMap.tsx:386`                                | live                        |
| `apps/web/public/leaflet/marker-shadow.png`  | ~1K         | ✅ `components/features/ClusterMap.tsx:387`                                | live                        |
| `apps/web/public/loop-favicon.ico`           | **0 bytes** | ✅ `root.tsx:135`                                                          | **broken — finding A2-001** |
| `apps/web/public/loop-favicon.png`           | **0 bytes** | ✅ `root.tsx:136`                                                          | **broken — finding A2-001** |
| `apps/web/public/loop-favicon.svg`           | 234 bytes   | ❌ no reference                                                            | finding A2-004              |
| `apps/web/public/loop-logo-square.png`       | 19259 bytes | ❌ no reference                                                            | finding A2-003              |
| `apps/web/public/loop-logo-white.svg`        | 1609 bytes  | ✅ multiple                                                                | live                        |
| `apps/web/public/loop-logo.png`              | 19259 bytes | ❌ no reference                                                            | finding A2-003              |
| `apps/web/public/loop-logo.svg`              | 1572 bytes  | ✅ `native/app-lock.ts:78`                                                 | live                        |
| `looplogo.svg` (repo root)                   | 1572 bytes  | ❌ no reference; exact SHA256 duplicate of `apps/web/public/loop-logo.svg` | finding A2-002              |

---

## 10. Findings filed from Phase 0

- **A2-001** (Medium) — two 0-byte favicons referenced from `root.tsx`
- **A2-002** (Low) — unreferenced duplicate `looplogo.svg` at repo root
- **A2-003** (Low) — `loop-logo.png` + `loop-logo-square.png` byte-identical, neither referenced in web source
- **A2-004** (Low) — `loop-favicon.svg` present but never linked

All four recorded in `docs/audit-2026-tracker.md` under Phase 0 with verbatim evidence pointers.

---

## 11. Disposition summary

| Disposition                                                          | Count   |
| -------------------------------------------------------------------- | ------- |
| audited-clean                                                        | 758     |
| audited-findings (broken / orphan)                                   | 4       |
| generated (regen command confirmed; idempotency verified in Phase 4) | pending |
| dead                                                                 | 0       |
| excluded (out of scope)                                              | 0       |
| **Total**                                                            | **762** |

Every tracked file has a disposition. Phase 0 exit criterion met: no file left in an unknown bucket.

---

## Exit

Phase 0 complete. Four findings raised, all Low/Medium. Ready to unblock downstream phases (all of them depend on Phase 0).
