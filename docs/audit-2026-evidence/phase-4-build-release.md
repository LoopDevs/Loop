# Phase 4 — Build & release reproducibility (evidence)

**Commit SHA at capture:** `450011ded294b638703a9ba59f4274a3ca5b7187`
**Date captured:** 2026-04-23
**Auditor:** cold-reviewer (Phase 4)
**Tools present on audit host:** `docker` (run only for read), `flyctl`.
**Deferred probes (tools not installed):** `trivy`, `grype`, `syft`, `cosign`.

Primary evidence: file citations with line numbers, raw `diff` output, overlay run logs, `flyctl config validate` exit codes, direct inspection of `drizzle-orm/postgres-js/migrator.js` source.

---

## 1. Dockerfile audit (backend vs web)

| Property                               | `apps/backend/Dockerfile`                 | `apps/web/Dockerfile`                                   |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| Base image                             | `node:22-alpine` (L1, L21)                | `node:22-alpine` (L1, L24)                              |
| Pinned by SHA256 digest?               | **No** — floating tag                     | **No** — floating tag                                   |
| Multi-stage build?                     | Yes — `builder` + runtime (L1, L21)       | Yes — `builder` + runtime (L1, L24)                     |
| `npm ci --ignore-scripts`?             | Yes (L10, L28)                            | Yes (L11, L31)                                          |
| Build-context root                     | Repo root (COPY paths rooted at `apps/…`) | Repo root (COPY paths rooted at `apps/…`, `packages/…`) |
| Non-root runtime user                  | Yes — `USER node` after chown (L33–39)    | Yes — `USER node` after chown (L37–44)                  |
| Runtime port declared                  | `EXPOSE 8080` (L41)                       | `EXPOSE 3000` (L46)                                     |
| NODE_ENV=production set                | Yes (L42)                                 | Yes (L47)                                               |
| **HEALTHCHECK directive?**             | **Missing**                               | **Missing**                                             |
| Process PID 1 / signal-forward wrapper | Direct `node` (L44) — no tini/dumb-init   | `npx react-router-serve` via shell (L50)                |
| Deterministic install locks            | `package-lock.json` + `npm ci`            | `package-lock.json` + `npm ci` + `npm rebuild`          |
| Secrets at build                       | None                                      | `VITE_API_URL` ARG baked at build (L19–20)              |
| SBOM emitted                           | No                                        | No                                                      |
| Image scan step                        | No                                        | No                                                      |
| Image signing                          | No                                        | No                                                      |
| Build-provenance attestation           | No                                        | No                                                      |

`.dockerignore` is present only at repo root (`/Users/ash/code/loop-app/.dockerignore`); neither `apps/backend/.dockerignore` nor `apps/web/.dockerignore` exists. `flyctl` packs the repo-root context when launched from the app subdir, so the root file applies; a contributor running `docker build -f apps/backend/Dockerfile apps/backend` from the app dir would see a blown-up context.

### Deploy-context ambiguity

`docs/deployment.md` L30–46 tells the operator to `cd apps/backend && fly deploy`, but the `Dockerfile` COPY paths are rooted at the monorepo root (`COPY apps/backend/package.json apps/backend/`). This works only because `flyctl` auto-walks up to the monorepo root for workspace context; there is no explicit `primary_region`-style declaration in `fly.toml` and nothing documents the behavior. A user launching `docker build -f apps/backend/Dockerfile .` from inside `apps/backend/` will fail at the first COPY — this is silent operator friction.

---

## 2. fly.toml parity table

| Field                                   | backend (`loopfinance-api`) | web (`loop-web`)                   |
| --------------------------------------- | --------------------------- | ---------------------------------- |
| `app`                                   | `loopfinance-api`           | `loop-web`                         |
| `primary_region`                        | `iad`                       | `iad`                              |
| `[build]` block                         | empty                       | `[build.args]` sets `VITE_API_URL` |
| `[env]` — `PORT`                        | `"8080"`                    | `"3000"`                           |
| `[env]` — `NODE_ENV`                    | `"production"`              | `"production"`                     |
| `[env]` — `LOG_LEVEL`                   | `"info"`                    | — (web has none)                   |
| `[env]` — SSRF allowlist                | `IMAGE_PROXY_ALLOWED_HOSTS` | n/a                                |
| `[env]` — `TRUST_PROXY`                 | `"true"`                    | n/a                                |
| `force_https`                           | `true`                      | `true`                             |
| `auto_stop_machines`                    | `"stop"`                    | `"stop"`                           |
| `auto_start_machines`                   | `true`                      | `true`                             |
| `min_machines_running`                  | `1`                         | `1`                                |
| concurrency `hard_limit / soft_limit`   | `250 / 200`                 | `250 / 200`                        |
| HTTP health-check path                  | `/health`                   | `/`                                |
| health-check interval / timeout / grace | `15s / 5s / 30s`            | `15s / 5s / 30s`                   |
| `[[vm]] memory`                         | `512mb`                     | `256mb`                            |
| `[[vm]] cpu_kind / cpus`                | `shared / 1`                | `shared / 1`                       |
| `release_command` / `[deploy]` ordering | **absent**                  | **absent**                         |

### `flyctl config validate` results

```
apps/backend/fly.toml → ✓ Configuration is valid (exit 0)
apps/web/fly.toml     → ✓ Configuration is valid (exit 0)
```

Both pass the modern health-check schema that replaced the orphaned `[[services.http_checks]]` block referenced at `apps/backend/fly.toml:33–41`. No `[deploy] release_command` in either file — migrations run only on the new machine's own boot via `apps/backend/src/index.ts:25–27`, meaning a partial migration failure hangs the booting instance but leaves the old machine serving until Fly's max-unavailable threshold kicks in. Ordering is only documented inline as a source comment, not in `docs/deployment.md`.

---

## 3. Overlay script idempotency

Script: `apps/mobile/scripts/apply-native-overlays.sh`.

Native projects are present under `apps/mobile/{ios,android}` (confirmed gitignored via `.gitignore:15-16`), so the script has live targets.

### Pass 1 (cold) → `/tmp/overlay-pass-1.log`

```
[apply-native-overlays] Copying backup rules XML into …/res/xml
[apply-native-overlays] Copying MainActivity override into …/java/io/loopfinance/app
[apply-native-overlays] Copied Loop launcher icons into mipmap-* folders
[apply-native-overlays] Copied ic_launcher_background color override
[apply-native-overlays] Copied styles.xml splash theme override
[apply-native-overlays] Copied Loop splash.png into drawable-* folders
[apply-native-overlays] Copied Loop splash_icon.png
[apply-native-overlays] Copied AVD splash drawables
[apply-native-overlays] AndroidManifest.xml already has backup-content attributes, skipping
[apply-native-overlays] Info.plist already has NSFaceIDUsageDescription, skipping
[apply-native-overlays] Info.plist already has NSLocationWhenInUseUsageDescription, skipping
[apply-native-overlays] Done.   (exit 0)
```

### Pass 2 (after snapshotting Manifest + Plist) → `/tmp/overlay-pass-2.log`

Identical stdout. `diff` of the snapshots against the in-place files:

```
$ diff /tmp/manifest-before-pass2.xml apps/mobile/android/…/AndroidManifest.xml
# (no output)
$ diff /tmp/plist-before-pass2.plist apps/mobile/ios/App/App/Info.plist
# (no output)
```

**Conclusion:** the two conditionally-patched text files (`AndroidManifest.xml`, `Info.plist`) are byte-identical after a second run. The script is idempotent **for the narrow surfaces it guards**, but it does an unconditional overwrite (`cp`) of every icon / splash / drawable / `MainActivity.java` / `styles.xml` / `backup_rules.xml` / `data_extraction_rules.xml` / `ic_launcher_background.xml` on every run. This is not a correctness problem (files are reproducible, mtime churn only) but mtime noise is visible in `ls -l` output after every invocation — captured here because pass-2 `diff` of those files against the overlay source is also empty by construction.

### ADR 006 / 008 claim verification

| Claim                                                                                      | Actual file                                | Present? |
| ------------------------------------------------------------------------------------------ | ------------------------------------------ | -------- |
| `NSFaceIDUsageDescription` present in iOS `Info.plist` (ADR 006 + audit A-034)             | `apps/mobile/ios/App/App/Info.plist:27–28` | Yes      |
| `NSLocationWhenInUseUsageDescription` present                                              | `Info.plist:29–30`                         | Yes      |
| `android:fullBackupContent="@xml/backup_rules"` on `<application>` (ADR 006 + audit A-033) | `AndroidManifest.xml:13`                   | Yes      |
| `android:dataExtractionRules="@xml/data_extraction_rules"`                                 | `AndroidManifest.xml:14`                   | Yes      |
| `backup_rules.xml` + `data_extraction_rules.xml` copied into `res/xml/`                    | present after pass 1                       | Yes      |
| `ACCESS_FINE_LOCATION` + `ACCESS_COARSE_LOCATION` uses-permission                          | `AndroidManifest.xml:51–52`                | Yes      |

**Drift detected:** the overlay script sets NSFaceIDUsageDescription to:

> "Loop uses Face ID to lock the app so your gift cards stay private, even if your unlocked device is in someone else's hands."

The live `Info.plist:28` holds a different copy-string:

> "Loop uses Face ID to lock the app and keep your gift cards private when your device is unlocked to someone else."

Because the script only writes the value when the key is absent, the plist copy will **never re-converge** to the script's canonical string; a copy-edit to the script has no effect on an already-populated plist. Filed as a low-severity finding — the App Store approval risk is that a developer updates the script expecting the new copy to roll out, and it silently doesn't.

---

## 4. Proto regeneration diff

Command: `npm run proto:generate` (runs `cd apps/backend && npx buf generate`, wiring `buf.build/bufbuild/es` → `../../packages/shared/src`).

Before: `packages/shared/src/proto/clustering_pb.ts` @ HEAD (450011de).
After: rerun then `diff` before/after.

**The diff is not empty.** Representative hunks (full diff logged in evidence stdout):

```diff
-import type { GenFile, GenMessage } from '@bufbuild/protobuf/codegenv2';
+import type { GenFile, GenMessage } from "@bufbuild/protobuf/codegenv2";

-export const file_proto_clustering: GenFile =
-  /*@__PURE__*/
-  fileDesc(
-    'ChZwcm90by9jbHVzdGVyaW5nLnByb3RvEgpjbHVzdGVyaW5nIjIKC0Nvb3Jk…',
-  );
+export const file_proto_clustering: GenFile = /*@__PURE__*/
+  fileDesc("ChZwcm90by9jbHVzdGVyaW5nLnByb3RvEgpjbHVzdGVyaW5nIjIKC0Nvb3Jk…");

-export type Coordinates = Message<'clustering.Coordinates'> & {
+export type Coordinates = Message<"clustering.Coordinates"> & {
```

Two drifts: (a) single-quote vs double-quote on emitted string literals, (b) whitespace / line-wrap differences on `/*@__PURE__*/` + `fileDesc(...)` / `messageDesc(...)` calls. The committed file is clearly the plugin output post-Prettier, while `buf generate` emits the plugin's raw output. No `prettier` step exists in the `proto:generate` script — the committed state was produced by running `buf generate` and then running Prettier manually, without documenting the two-step procedure.

Workspace was restored to HEAD after measurement (`git restore packages/shared/src/proto/clustering_pb.ts`); `git status` shows no pending change from this audit. (An unrelated pre-existing edit to `docs/audit-2026-adversarial-plan.md` was already in the working tree when the audit started.)

---

## 5. Drizzle migration snapshot

| Source                                             | Files                                  |
| -------------------------------------------------- | -------------------------------------- |
| SQL migration files on disk (`…/migrations/*.sql`) | `0000` … `0011` (12 files)             |
| `meta/_journal.json` entries                       | `0000` … `0010` (**11 entries**)       |
| `meta/NNNN_snapshot.json` files                    | Only `0000_snapshot.json` (**1 file**) |

`0011_admin_idempotency_keys.sql` is **absent from `_journal.json`.** The drizzle migrator (`node_modules/drizzle-orm/migrator.js:12-28`) iterates over `journal.entries` only — it never enumerates the `.sql` folder. A fresh deploy that runs `runMigrations()` (called unconditionally in `apps/backend/src/index.ts:25-27` for any non-test `NODE_ENV`) will **silently skip 0011**, leaving `admin_idempotency_keys` uncreated. Code that reads/writes that table (`apps/backend/src/admin/idempotency.ts`, `admin/audit-tail.ts`, `admin/audit-tail-csv.ts`, plus a reference in `app.ts`) would break the moment an admin mutating endpoint is hit on a machine booted cleanly from this repo state.

This is phase-6-adjacent but discovered through the Phase-4 regenerability check; filing here and cross-linking when Phase 6 reopens the data-layer audit.

Additionally, post-0000 migrations 0001–0010 have _no_ per-migration snapshot (`0001_snapshot.json` … `0010_snapshot.json` missing), meaning `drizzle-kit db:generate` would not be able to diff the current schema against the prior state to emit a new migration — the schema-vs-journal snapshot chain is broken. This is consistent with the migrations having been hand-authored SQL rather than drizzle-kit-emitted (0011 has no `--> statement-breakpoint` directives; 0001 does).

---

## 6. tsup / vite / react-router config

| Config              | File                              | Notable                                                                                                 |
| ------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Backend bundler     | `apps/backend/tsup.config.ts`     | `format: ['esm']`, `target: 'node22'`, `sourcemap: true`, `noExternal: ['@loop/shared']`, `clean: true` |
| Web bundler         | `apps/web/vite.config.ts`         | React Router + Tailwind plugins; native tsconfig-paths via `resolve.tsconfigPaths`; dev proxy to API    |
| React Router config | `apps/web/react-router.config.ts` | `ssr` toggled off when `BUILD_TARGET=mobile` — confirms static-export constraint                        |
| E2E default         | `playwright.config.ts`            | `testDir: ./tests/e2e`; real upstream; starts web dev server; CI retries 2                              |
| E2E mocked          | `playwright.mocked.config.ts`     | Boots mock-ctx + tsx backend on :8081 + web on :5174; `DISABLE_RATE_LIMITING=1` in backend env          |

No finding on these files; all consistent with documented behavior.

---

## 7. docker-compose.yml — dev parity to prod

Single service `db: postgres:16` bound to `127.0.0.1:5433→5432`, persistent named volume, healthcheck via `pg_isready`. No `backend`/`web` services — production deployment is via Fly images built from the Dockerfiles, so dev and prod diverge on runtime (tsx watch vs bundled node), but the bundled build is exercised in CI's `build` job (`.github/workflows/ci.yml:135-144`). No Docker test of the runtime image is performed in CI; the image is only built in production by Fly's remote builder on `fly deploy`.

---

## 8. `scripts/verify.sh`

Runs, in order, `npm run typecheck` → `npm run lint` → `npm run format:check` → `./scripts/lint-docs.sh` → `npm test`. `set -euo pipefail`. Pre-push hook (`.husky/pre-push:10-12`) runs `npm test && ./scripts/lint-docs.sh && npx lint-staged` — **not** `scripts/verify.sh` itself, so a local push that skips typecheck / lint / format would still succeed at the hook level. `AGENTS.md` documents `npm run verify` as the single-command gate; the pre-push hook diverges from that.

---

## 9. SBOM / provenance / scanning / signing — presence matrix

| Capability                                                   | Present?    | Source                                                                                                                                                                                  |
| ------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SBOM generation (CycloneDX / SPDX)                           | **No**      | `grep -r syft\|cyclone\|spdx .github/` → no matches                                                                                                                                     |
| Build-provenance attestation (`attest-build-provenance`)     | **No**      | no `attestations:` permission in `ci.yml`; no action reference                                                                                                                          |
| Container vulnerability scan (trivy / grype) in CI           | **No**      | not referenced in any workflow                                                                                                                                                          |
| Image signing (cosign / sigstore)                            | **No**      | Not in workflow; Fly deploy is direct push to registry                                                                                                                                  |
| `npm audit` in CI                                            | Yes         | `ci.yml:100-111` (`--audit-level=high`)                                                                                                                                                 |
| Dependency / supply-chain review action                      | **No**      | no `dependency-review-action`                                                                                                                                                           |
| Build reproducibility documented (source-SHA → image-digest) | **No**      | no docs or workflow guarantees byte-equivalence across two builds of the same SHA                                                                                                       |
| Migration-vs-deploy ordering documented                      | **Partial** | only an inline code comment at `apps/backend/src/index.ts:19-24`; no `release_command` in fly.toml; no section in `docs/deployment.md` describing "apply migrations, then roll forward" |
| Pinned GitHub-Actions SHAs                                   | **No**      | `actions/checkout@v6`, `setup-node@v4`, `flyctl-actions/setup-flyctl@master` — tag-pinned, not SHA-pinned                                                                               |

Deferred (tool-unavailable on audit host): any probe that would require `trivy`, `grype`, `syft`, or `cosign` to produce comparative output. Their absence in CI is nevertheless confirmed by reading the three workflow files.

---

## 10. Capacitor plugin parity (mobile vs web)

Both `apps/web/package.json` and `apps/mobile/package.json` declare the same `@capacitor/core`, `@capacitor/app`, `@capacitor/clipboard`, `@capacitor/filesystem`, `@capacitor/haptics`, `@capacitor/keyboard`, `@capacitor/preferences`, `@capacitor/push-notifications`, `@capacitor/share`, `@capacitor/status-bar`, `@aparajita/capacitor-biometric-auth`, `@aparajita/capacitor-secure-storage` at identical versions. Mobile-only: `@capacitor/android`, `@capacitor/ios`, `@capacitor/cli`, `@capacitor/splash-screen`. No drift.

---

## 11. Findings

All filed in this phase; every finding is in-scope for post-audit remediation per plan §0.4 / §3.4.

### A2-401 — drizzle `_journal.json` missing migration 0011 (High)

`apps/backend/src/db/migrations/0011_admin_idempotency_keys.sql` exists on disk but is **not** referenced from `apps/backend/src/db/migrations/meta/_journal.json`. The drizzle migrator only applies migrations listed in `journal.entries` (`node_modules/drizzle-orm/migrator.js:12-28`). Any fresh deploy running `runMigrations()` will silently skip this migration, leaving `admin_idempotency_keys` uncreated and admin idempotency / audit-tail writes broken on first use. Pre-launch, but the defect would materialize the first time a new region spins up.

### A2-402 — `HEALTHCHECK` directive missing in both Dockerfiles (Medium)

`apps/backend/Dockerfile` and `apps/web/Dockerfile` declare no `HEALTHCHECK`. Fly's own HTTP health-check compensates in production, but any non-Fly runtime (local docker, other orchestrators, a transitional build) has no in-image probe. Finding is Medium rather than Low because the image is the only transferable artifact and the Fly check lives in a separate config file.

### A2-403 — Base image pinned by floating tag, not SHA256 digest (Medium)

Both Dockerfiles use `FROM node:22-alpine` without `@sha256:…` pinning (`apps/backend/Dockerfile:1,21`, `apps/web/Dockerfile:1,24`). A poisoned or silently-updated upstream mirror would change the build. Cross-reference: plan G2-20 (covered tag pinning); G5-19 (deeper reproducibility-under-poisoned-cache review). Both Dockerfiles should pin by digest and be refreshed via dependabot.

### A2-404 — Proto regeneration not idempotent vs checked-in file (Medium)

`npm run proto:generate` rewrites `packages/shared/src/proto/clustering_pb.ts` with a different whitespace + quote style than the file committed at HEAD. Any contributor running the command will introduce a large unrelated diff in their PR unless they remember to run Prettier. Either the script should pipe through `prettier` before writing (so the output matches the committed style), or the repo should adopt the buf-plugin emitted style and stop formatting the file.

### A2-405 — NSFaceIDUsageDescription copy drift between overlay script and live plist (Low)

`apps/mobile/scripts/apply-native-overlays.sh:179` sets the `NSFaceIDUsageDescription` value only when the key is absent. The script's canonical copy ("…so your gift cards stay private, even if your unlocked device is in someone else's hands.") differs from the live `apps/mobile/ios/App/App/Info.plist:28` value ("…and keep your gift cards private when your device is unlocked to someone else."). A copy edit to the script will not propagate; the plist is effectively write-once until manually deleted.

### A2-406 — Overlay script overwrites assets unconditionally even when identical (Low)

Every non-conditional `cp` in `apply-native-overlays.sh` (launcher icons, splash drawables, `MainActivity.java`, `styles.xml`, `ic_launcher_background.xml`, `backup_rules.xml`, `data_extraction_rules.xml`) runs on every invocation regardless of whether the source and destination are byte-equal. Function-wise correct and idempotent — pass-2 diff is empty — but produces spurious mtime changes, making "did the second pass do anything?" noisier than necessary for future audits. A `cmp -s` gate would let the script skip unchanged files.

### A2-407 — Migration-vs-deploy ordering not documented and no `release_command` (Medium)

Neither `apps/backend/fly.toml` nor `apps/web/fly.toml` declares a `[deploy] release_command`. Migrations run only in-process on each new machine's boot (`apps/backend/src/index.ts:25-27`). There is no Fly-orchestrated pre-deploy migration step; no rollback-on-migration-failure story; no section in `docs/deployment.md` covering the case where a migration fails mid-rollout. Plan §Phase 4 + G5-21 call for this to be explicit.

### A2-408 — SBOM, provenance attestation, container scanning, and image signing all absent (Medium)

CI does not generate an SBOM (syft / cyclonedx / spdx), does not emit a build-provenance attestation, does not scan built images for CVEs (trivy / grype), and does not sign images (cosign / sigstore). `npm audit` is present but operates on the lockfile, not the runtime image layers. Grouped as one finding because the remediation is one workstream ("add a release-hardening workflow"); can be split later.

### A2-409 — GitHub Actions pinned by floating tag, not commit SHA (Medium)

`ci.yml` uses `actions/checkout@v6`, `actions/setup-node@v4`, `actions/cache@v4`, `actions/upload-artifact@v7`, `actions/download-artifact@v7`, and especially `superfly/flyctl-actions/setup-flyctl@master`. A takeover or tag-move on any of those references would execute attacker-controlled code with `contents: read` access and a valid `GITHUB_TOKEN`. `@master` is worst — a force-push to `master` ships immediately.

### A2-410 — `.dockerignore` lives only at repo root, not per-app (Low)

A contributor running `docker build -f apps/backend/Dockerfile apps/backend` (from inside the app dir, a natural reading of `docs/deployment.md`) gets no `.dockerignore` applied, meaning `node_modules/`, `.git/`, coverage artefacts, etc. are streamed into the context. Fly's own builder uploads the monorepo root so it works there, but the deploy docs should either ship per-app `.dockerignore` symlinks or explicitly say "build context is the repo root". As filed, this is also operator-ergonomic, not a correctness defect.

### A2-411 — `.husky/pre-push` does not call `scripts/verify.sh` (Low)

`AGENTS.md` Quick commands promote `npm run verify` as the single-command gate, and `verify.sh` covers typecheck / lint / format / docs-lint / tests. But the actual pre-push hook (`.husky/pre-push:10-12`) only runs `npm test`, `./scripts/lint-docs.sh`, and `npx lint-staged` — it skips `typecheck`, `lint`, and `format:check`. A developer who pushes from the CLI and doesn't manually run verify can land a typecheck-broken tree in CI and waste a round-trip. CI still catches it, but the local gate is looser than advertised.

### A2-412 — Drizzle snapshot chain is broken for every migration after 0000 (Info → escalate if schema diff ever needed)

`meta/0000_snapshot.json` is the only per-migration snapshot; `0001_snapshot.json` through `0011_snapshot.json` are absent. `drizzle-kit db:generate` works off the latest snapshot plus the schema.ts to diff — with only the 0000 snapshot, any attempt to generate a new migration from `schema.ts` diffs against the initial-schema shape rather than the current shape, producing nonsense output. Hand-authored SQL works at runtime (given the journal is fixed per A2-401), but the `db:generate` workflow in `drizzle.config.ts` is non-functional until snapshots are regenerated.

---

## 12. Exit

Phase 4 complete as far as locally-measurable evidence allows. Twelve findings filed: one **High** (A2-401), six **Medium** (A2-402, A2-403, A2-404, A2-407, A2-408, A2-409), four **Low** (A2-405, A2-406, A2-410, A2-411), one **Info** (A2-412). All twelve enter the post-audit remediation queue per plan §0.4 / §3.4. No configuration or source file was modified by this audit; proto regeneration was captured then `git restore`d; overlay passes were against already-generated (gitignored) native projects.

Deferred probes (require tools not installed on audit host): image CVE scan with `trivy` / `grype`, SBOM generation with `syft`, image signature verification with `cosign`. The absence of these capabilities in CI — separately verified by reading the workflow files — is sufficient to file A2-408; a future re-audit with the tools installed can add a depth probe if needed.
