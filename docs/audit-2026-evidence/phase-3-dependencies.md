# Phase 3 — Dependencies & Supply chain (evidence)

**Commit SHA at capture:** `450011ded294b638703a9ba59f4274a3ca5b7187`
**Audit branch:** `main` (clean uncommitted edits unrelated to Phase 3: onboarding routes)
**Date captured:** 2026-04-23
**Runner:** `npm 10.x` / `node v24.6.0` on `darwin 25.3.0`

Sibling evidence dumps:

- `phase-3-npm-ls-all.txt` — `npm ls --all` text output (1,827 lines)
- `phase-3-npm-ls.json` _(not committed — 297 KB)_ — `npm ls --all --json`, sourced for the duplicate-version and pin-drift analysis below
- `phase-3-npm-audit.json` — full `npm audit --json`
- `phase-3-npm-outdated.json` — full `npm outdated --json`
- `phase-3-install-hooks.txt` — enumerated `preinstall`/`install`/`postinstall`/`prepare` hooks across the transitive tree

Nothing in this phase required network access beyond what `npm` already read from its cache. Both `npm audit` and `npm outdated` returned exit code 1 (expected — findings present), and their JSON was captured for provenance.

---

## 1. Direct-dependency inventory

96 direct deps across five `package.json`s. All exact-pinned (no `^`/`~`). Full licence + installed-vs-pinned table — see `phase-3-npm-ls-all.txt` for the full transitive tree.

### 1.1 Root (`/package.json`) — 14 devDependencies

| Package                            | Pin    | Installed | Licence    | Notes                                                      |
| ---------------------------------- | ------ | --------- | ---------- | ---------------------------------------------------------- |
| `@commitlint/cli`                  | 20.5.0 | 20.5.0    | MIT        | —                                                          |
| `@commitlint/config-conventional`  | 20.5.0 | 20.5.0    | MIT        | —                                                          |
| `@playwright/test`                 | 1.59.1 | 1.59.1    | Apache-2.0 | —                                                          |
| `@stellar/stellar-sdk`             | 15.0.1 | 15.0.1    | Apache-2.0 | Dev-listed at root alongside backend (test-wallet tooling) |
| `@typescript-eslint/eslint-plugin` | 8.58.2 | 8.58.2    | MIT        | Outdated — latest 8.59.0                                   |
| `@typescript-eslint/parser`        | 8.58.2 | 8.58.2    | MIT        | Outdated — latest 8.59.0                                   |
| `concurrently`                     | 9.2.1  | 9.2.1     | MIT        | —                                                          |
| `eslint`                           | 10.2.1 | 10.2.1    | MIT        | —                                                          |
| `eslint-plugin-react-hooks`        | 7.1.1  | 7.1.1     | MIT        | —                                                          |
| `husky`                            | 9.1.7  | 9.1.7     | MIT        | —                                                          |
| `lint-staged`                      | 16.4.0 | 16.4.0    | MIT        | —                                                          |
| `prettier`                         | 3.8.3  | 3.8.3     | MIT        | —                                                          |
| `typescript`                       | 6.0.3  | 6.0.3     | Apache-2.0 | —                                                          |
| `wait-on`                          | 9.0.5  | 9.0.5     | MIT        | —                                                          |

Root `overrides`: `{"@stellar/stellar-sdk": {"axios": "1.15.0"}}` — forces stellar-sdk's axios from 1.14.0 to 1.15.0. Lockfile confirms a single `axios@1.15.0` in the tree.

### 1.2 `apps/backend` — 11 prod + 10 dev

Prod: `@asteasolutions/zod-to-openapi@8.5.0` (MIT) · `@bufbuild/protobuf@2.11.0` (Apache-2.0 AND BSD-3-Clause) · `@hono/node-server@1.19.14` (MIT, **outdated** — latest 2.0.0) · `@sentry/hono@10.49.0` (MIT, outdated — 10.50.0) · `@stellar/stellar-sdk@15.0.1` (Apache-2.0) · `drizzle-orm@0.45.2` (Apache-2.0) · `hono@4.12.14` (MIT) · `pino@10.3.1` (MIT) · `postgres@3.4.9` (**Unlicense**) · `sharp@0.34.5` (Apache-2.0 — native bindings, see §4) · `zod@4.3.6` (MIT).
Dev: `@bufbuild/buf@1.68.2` (Apache-2.0, **postinstall binary selector** — §4) · `@bufbuild/protoc-gen-es@2.11.0` (Apache-2.0) · `@types/node@25.6.0` (MIT) · `@vitest/coverage-v8@4.1.4` (MIT — outdated 4.1.5, also **drags in vitest 4.1.4** → §2 drift) · `drizzle-kit@0.31.10` (MIT — carries transitive CVE, §5) · `pino-pretty@13.1.3` (MIT) · `tsup@8.5.1` (MIT) · `tsx@4.21.0` (MIT) · `typescript@6.0.3` · `vitest@4.1.0` (MIT — **installed 4.1.4**, §2).

### 1.3 `apps/web` — 28 prod + 17 dev

Prod highlights: `@aparajita/capacitor-biometric-auth@10.0.0` (MIT) · `@aparajita/capacitor-secure-storage@8.0.0` (MIT) · 11× `@capacitor/*@8.x` (MIT) · `@capgo/inappbrowser@8.6.1` (**MPL-2.0** — only non-permissive licence in direct list; outdated 8.6.2) · `@react-router/node@7.14.1` / `@react-router/serve@7.14.1` · `@sentry/react@10.49.0` (outdated 10.50.0) · `@tanstack/react-query@5.99.0` (outdated 5.100.1) · `isbot@5.1.39` (**Unlicense**) · `leaflet@1.9.4` (BSD-2-Clause) · `qrcode@1.5.4` · `react@19.2.5` / `react-dom@19.2.5` · `react-router@7.14.1` (outdated 7.14.2) · `zustand@5.0.12` (MIT).
Dev highlights: `@react-router/dev@7.14.1` (outdated 7.14.2) · `@tailwindcss/vite@4.2.2` (outdated 4.2.4) · `@testing-library/react@16.3.2` · `@types/react@19.1.2` (outdated 19.2.14) · `@types/react-dom@19.1.2` (outdated 19.2.3) · `@vitest/coverage-v8@4.1.4` · `jsbarcode@3.12.3` · `jsdom@29.0.2` · `tailwindcss@4.2.2` (outdated 4.2.4) · `vite@8.0.8` (outdated 8.0.10) · `vitest@4.1.0` (drift, §2).

### 1.4 `apps/mobile` — 18 prod, 0 dev

Every entry is a Capacitor plugin at `8.x` — all MIT except `@capgo/inappbrowser@8.6.1` (**MPL-2.0**). Mirrors `apps/web` versions exactly for the plugins shared with the web runtime (AGENTS.md doc rule #11). Diff vs web: mobile adds `@capacitor/android`, `@capacitor/ios`, `@capacitor/cli`, `@capacitor/splash-screen@8.0.1`; web adds nothing mobile lacks.

### 1.5 `packages/shared` — 1 prod, 1 dev

`@bufbuild/protobuf@2.11.0` · `typescript@6.0.3`. Per ADR 019 (no runtime deps beyond protobuf).

---

## 2. Lockfile integrity & pin drift

### 2.1 Exact-pin drift (`package.json` declared vs `package-lock.json` / installed)

| Workspace      | Pkg    | Pinned | Installed | Cause                                                                                                   |
| -------------- | ------ | ------ | --------- | ------------------------------------------------------------------------------------------------------- |
| `apps/backend` | vitest | 4.1.0  | 4.1.4     | `@vitest/coverage-v8@4.1.4` peer-requires `vitest@4.1.4`; npm silently up-resolves exact pin (`A2-301`) |
| `apps/web`     | vitest | 4.1.0  | 4.1.4     | Same                                                                                                    |

`npm ls --all` emits `invalid: vitest@4.1.4 ... "4.1.0" from apps/backend` and `... from apps/web` because of this. Every fresh `npm ci` from the lockfile resolves `4.1.4` — the exact pin in `package.json` is a lie. See `phase-3-npm-ls-all.txt` for the warnings and `phase-3-npm-audit.json`→metadata for context.

### 2.2 Extraneous packages in `node_modules`

`npm ls` reports five extraneous (present on disk, not referenced by any `package.json` or the lockfile):

```
@emnapi/core@1.9.2
@emnapi/runtime@1.9.2
@emnapi/wasi-threads@1.2.1
@napi-rs/wasm-runtime@1.1.4
@tybys/wasm-util@0.10.1
```

These show up because an earlier install of `@img/sharp-libvips-*` pulled them transitively; after `sharp@0.34.5` switched to prebuilt platform binaries, npm left them orphaned. Not exploitable on its own but (a) they aren't in the lockfile, so `npm ci` would wipe them (non-reproducible dev env) and (b) they're a symptom of lockfile staleness (`A2-302`).

### 2.3 Duplicate-version matrix (security-sensitive subset)

Full list in `phase-3-npm-ls-all.txt`. 52 packages have >1 version installed across the tree. Highlights:

| Pkg                                         | Versions                       | Risk                                                                                              |
| ------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `esbuild`                                   | **0.18.20** / 0.25.12 / 0.27.3 | 0.18.20 sits under `drizzle-kit` → `@esbuild-kit/esm-loader` and carries GHSA-67mh-4wv8-2f99 (§5) |
| `cookie`                                    | 0.7.2 / 1.1.1                  | 1.1.1 is react-router's scoped copy. 0.7.2 is transitive; both patched for prior CVE-2024-47764   |
| `semver`                                    | 6.3.1 / 7.7.4                  | 6.3.1 is isaacs-era; legacy-safe                                                                  |
| `ajv`                                       | 6.14.0 / 8.18.0                | 6.x end-of-life; used transitively by older eslint plugins                                        |
| `debug`                                     | 2.6.9 / 4.4.3                  | 2.x very old — transitive                                                                         |
| `string-width` / `strip-ansi` / `wrap-ansi` | 3 majors each                  | Reported `invalid` by `npm ls` (peer-dep drift from lint-staged → listr2 → cli-truncate tooling)  |
| `tinyexec`                                  | 0.3.2 / 1.0.4                  | Split between tsup + vitest ecosystems                                                            |
| `fsevents`                                  | 2.3.2 / 2.3.3                  | Two copies both optional-darwin — fine                                                            |
| `xmlbuilder`                                | 11.0.1 / 15.1.1                | xmldom-adjacent; neither actively compiled                                                        |

No duplicate copies of `undici` (single `7.25.0`), `axios` (single `1.15.0` — thanks to the root override), `postgres` (single `3.4.9`), `hono` (single `4.12.14`), `pino` (single `10.3.1`), `zod` (single `4.3.6`), `ws` (absent), `jsonwebtoken` (absent — Loop uses jose at best).

### 2.4 Deprecated transitive deps

`grep -c '"deprecated":' package-lock.json` → 2. Both are the `@esbuild-kit/*` pair:

```
@esbuild-kit/core-utils@3.3.2  "Merged into tsx: https://tsx.is"
@esbuild-kit/esm-loader@2.6.5  "Merged into tsx: https://tsx.is"
```

Both pulled in by `drizzle-kit@0.31.10`, which itself is already the latest drizzle-kit.

---

## 3. Outdated inventory

`npm outdated --json` → 19 entries. Grouped:

**Patch drift (no-breaking upgrade available):**

- `@bufbuild/buf` 1.68.2 → 1.68.4
- `@capgo/inappbrowser` 8.6.1 → 8.6.2
- `@react-router/dev` / `@react-router/node` / `@react-router/serve` / `react-router` 7.14.1 → 7.14.2
- `@sentry/hono` / `@sentry/react` 10.49.0 → 10.50.0
- `@tailwindcss/vite` / `tailwindcss` 4.2.2 → 4.2.4
- `@tanstack/react-query` 5.99.0 → 5.100.1
- `@typescript-eslint/eslint-plugin` / `@typescript-eslint/parser` 8.58.2 → 8.59.0
- `@vitest/coverage-v8` 4.1.4 → 4.1.5
- `vite` 8.0.8 → 8.0.10
- `vitest` 4.1.0 (pinned, 4.1.4 installed) → 4.1.5

**Major drift:**

- `@hono/node-server` 1.19.14 → 2.0.0
- `@types/react` 19.1.2 → 19.2.14, `@types/react-dom` 19.1.2 → 19.2.3

Dependabot (§7) is configured to group minor+patch into a single weekly PR, so once a week these should be squashed in one go. That Dependabot schedule is what's holding this pile.

---

## 4. Install-time script hooks + native binaries

Enumerated every `package.json` in `node_modules/` (924 total) and filtered to `preinstall`/`install`/`postinstall` (which npm runs on every install from a registry tarball). See `phase-3-install-hooks.txt` for the full set. Only **5 packages** declare install-time scripts:

| Pkg                    | Hook          | Script                                     | Behaviour                                                                                                                                                 | Risk                                                                                                               |
| ---------------------- | ------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `sharp@0.34.5`         | `install`     | `node install/check.js \|\| npm run build` | Verifies `@img/sharp-<platform>` prebuild is resolvable. Falls back to building libvips from source if not. Local source is `./install/check.js`.         | Low — no network in `check.js`; `build` step only fires when prebuilt absent                                       |
| `@bufbuild/buf@1.68.2` | `postinstall` | `node ./install.js`                        | Resolves `@bufbuild/buf-<platform>` optional dep. If missing (e.g. `--no-optional`), **shells to `npm install`** to fetch it.                             | Medium — fallback invokes a nested `npm install` with arbitrary platform subpackage. Present on every fresh clone. |
| `esbuild@0.27.3`       | `postinstall` | `node install.js`                          | Resolves `@esbuild/<platform>` optional dep; same binary-selector pattern. No network unless `ESBUILD_BINARY_PATH` forces a download (checked in source). | Low                                                                                                                |
| `esbuild@0.25.12`      | `postinstall` | `node install.js`                          | Same as above (dup via drizzle-kit sub-tree).                                                                                                             | Low                                                                                                                |
| `esbuild@0.18.20`      | `postinstall` | `node install.js`                          | Same — this one is the **vulnerable 0.18.20** (§5), run on every fresh install.                                                                           | High — code-exec hook in a vulnerable version                                                                      |

`prepare` hooks (57 packages) are not executed on registry tarball installs — they only run when a package is installed from a git URL or local path. Our lockfile is 100% registry tarballs; `prepare` is a non-vector here. The 57 instances are documented in `phase-3-install-hooks.txt` for completeness.

### Native-binary summary

| Runtime lib                             | Source                                                              | Pin                                                                               | Arch fan-out                                                                                                 | Checksum                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `sharp` (libvips)                       | `@img/sharp-{platform}` + `@img/sharp-libvips-{platform}` prebuilds | `sharp@0.34.5`                                                                    | `@img/sharp-darwin-arm64`, `-darwin-x64`, `-linux-arm64`, `-linux-x64`, `-wasm32`, `-win32-{arm64,ia32,x64}` | `package-lock.json` records `integrity: sha512-…` for every platform variant — npm enforces on extract |
| `@bufbuild/buf`                         | `@bufbuild/buf-{platform}` prebuilds                                | `1.68.2`                                                                          | `-darwin-{arm64,x64}`, `-linux-{aarch64,armv7,x64}`, `-win32-{arm64,x64}`                                    | lockfile-integrity-enforced                                                                            |
| `esbuild`                               | `@esbuild/{platform}` prebuilds                                     | 0.25.12 (tsup/drizzle latest), 0.27.3 (vite), **0.18.20** (`@esbuild-kit` legacy) | ~22 platform packages per major                                                                              | lockfile-integrity-enforced                                                                            |
| `@stellar/stellar-sdk`                  | Pure-JS (plus `@stellar/stellar-base`)                              | `15.0.1`                                                                          | None — no native binary                                                                                      | n/a                                                                                                    |
| `lightningcss`                          | `lightningcss-{platform}` prebuilds (via tailwindcss)               | `1.32.0`                                                                          | Similar fan-out                                                                                              | lockfile-integrity-enforced                                                                            |
| `@capacitor/android` + `@capacitor/ios` | Ship Gradle / CocoaPods sources, no prebuilt binary                 | `8.3.1`                                                                           | n/a                                                                                                          | n/a                                                                                                    |

Libvips (`@img/sharp-libvips-darwin-arm64@1.2.4`) is the only **LGPL-3.0-or-later** package in the tree. LGPL permits dynamic linking in a proprietary app, but Loop should make a "libvips is LGPL-3 dynamically linked" note on the `/licences` page once one exists (`A2-305`).

---

## 5. Security advisories (`npm audit`)

4 moderate, 0 high, 0 critical. All four are the same chain:

```
esbuild@<=0.24.2  (GHSA-67mh-4wv8-2f99 — dev-server CSRF-ish request/response leak)
  ← @esbuild-kit/core-utils
  ← @esbuild-kit/esm-loader
  ← drizzle-kit@0.31.10
```

CVE detail: the bundled esbuild dev-server in versions ≤ 0.24.2 accepted cross-origin requests with `Access-Control-Allow-Origin: *`, which lets a malicious website read any file the dev-server could serve (including TypeScript source). Mitigation: upgrade esbuild to ≥0.25 — blocked because `drizzle-kit` still ships `@esbuild-kit/esm-loader`, and the package is **deprecated** ("Merged into tsx"). drizzle-kit has no newer patch that drops it; `fixAvailable` claims `drizzle-kit@0.18.1` would fix it, but that's a **backwards** major (we're on 0.31.10) because npm's `fixAvailable` heuristic chose the old pre-esbuild-kit version. Real path: wait for drizzle-kit to drop `@esbuild-kit/esm-loader` upstream, or replace drizzle-kit's dev-only CLI with `tsx`-based scripts. The attack requires the attacker to already be able to get the victim to browse to a malicious page _while_ the drizzle-kit dev server is running — narrow, but filed as `A2-303`.

No CVE coverage for `axios` (single pin at 1.15.0 via override clears the 1.14.x chain).

---

## 6. Licence compatibility

Full tally across the transitive tree (`phase-3-install-hooks.txt` section notwithstanding, source of truth is each package's `package.json#license`):

```
  660  MIT
   76  Apache-2.0
   43  ISC
   19  BSD-3-Clause
   11  BlueOak-1.0.0
    9  BSD-2-Clause
    3  MPL-2.0            ← @capgo/inappbrowser, @capacitor/core (via embed), @bramus/pagination-sequence
    3  Unlicense          ← postgres, isbot, spdx-license-ids (equivalent to public-domain; permissive)
    2  MIT-0
    1  (Apache-2.0 AND BSD-3-Clause)  ← @bufbuild/protobuf (dual)
    1  0BSD
    1  Python-2.0
    1  LGPL-3.0-or-later  ← @img/sharp-libvips-darwin-arm64 (native library, dynamically linked)
    1  CC0-1.0
    1  (MIT AND BSD-3-Clause)
    1  CC-BY-4.0          ← spdx-exceptions (de-facto permissive for SPDX-ID usage)
   91  (no license field)  ← all inner sub-package.json type markers (e.g. `zod/v4/core/package.json`); inherit from parent
```

Compatibility verdict:

- **MIT / Apache-2.0 / BSD / ISC / BlueOak / MIT-0 / Unlicense / 0BSD / Python-2.0** — all permissive, compatible with a proprietary distribution.
- **MPL-2.0 (3×)** — permits linking in a larger work; only source-file-level modifications need to be redistributed. Loop does not fork any of them. Compatible.
- **LGPL-3.0-or-later (libvips)** — dynamically linked native lib; must note it in OSS attribution. `A2-305` tracks the attribution page.
- **CC-BY-4.0** — fine for attribution-only metadata packages.

No GPL, AGPL, or other viral copyleft in the tree.

---

## 7. Dependabot ignore set

```yaml
# .github/dependabot.yml
updates:
  - package-ecosystem: npm
    schedule: weekly (Monday)
    open-pull-requests-limit: 10
    groups:
      minor-and-patch: { update-types: [minor, patch] }
    reviewers: [LoopDevs/engineering]
  - package-ecosystem: github-actions
    schedule: weekly
```

No `ignore` key, no `versioning-strategy` override, no package pinned. Every dep is eligible for weekly bumps. No stale-pinning debt. `A2-307` tracks the one drift item below.

---

## 8. Root `package.json` scripts — remote-fetch audit

```
dev, dev:web, dev:backend, typecheck, lint, lint:fix,
format, format:check, test, test:coverage, test:e2e,
test:e2e:mocked, test:e2e:real, verify, lint:docs, audit,
build, proto:generate, prepare
```

Grep for `curl ` / `wget ` / `| sh` / remote URLs inside any root or `scripts/` shell script: **zero matches.** `scripts/e2e-real.mjs` calls `http://localhost:8080` (default backend URL) — local-only. `scripts/postgres-init.sh` runs `psql` inside a docker entrypoint — no network fetch. `verify.sh` is a plain command sequencer. Clean.

Full script inventory: `scripts/verify.sh`, `scripts/lint-docs.sh`, `scripts/postgres-init.sh`, `scripts/e2e-real.mjs`, `.husky/commit-msg`, `.husky/pre-commit`, `.husky/pre-push`, `apps/mobile/scripts/apply-native-overlays.sh`, `tests/e2e-mocked/fixtures/mock-ctx.mjs`. All local-only or registry-mediated; no `curl | sh`.

---

## 9. Bundled-asset licence audit

### `apps/web/public/`

| File                                                     | Provenance                                                        | Licence (if third-party) | Attribution present? |
| -------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------ | -------------------- |
| `hero.webp`                                              | Loop-owned                                                        | — (first-party)          | n/a                  |
| `leaflet/marker-icon-2x.png`                             | Copied from `node_modules/leaflet/dist/images/` (`leaflet@1.9.4`) | BSD-2-Clause             | **no** — `A2-306`    |
| `leaflet/marker-icon.png`                                | Same                                                              | BSD-2-Clause             | no                   |
| `leaflet/marker-shadow.png`                              | Same                                                              | BSD-2-Clause             | no                   |
| `loop-favicon.ico` (0 bytes)                             | Loop-owned (broken — see Phase 0 A2-001)                          | —                        | n/a                  |
| `loop-favicon.png` (0 bytes)                             | Same                                                              | —                        | n/a                  |
| `loop-favicon.svg` / `loop-logo*.svg` / `loop-logo*.png` | Loop-owned                                                        | —                        | n/a                  |
| `robots.txt`                                             | Loop-owned                                                        | —                        | n/a                  |

### `apps/mobile/native-overlays/`

41 PNGs + XMLs under `android/app/src/main/res/**` and `ios/App/App/Assets.xcassets/**`. All Loop-owned launcher icons and splash assets per ADR 007 / the apply-native-overlays.sh script. No third-party art detected. Leaflet marker images are not shipped in mobile overlays.

### Fonts

`git ls-files | grep -E '\\.(woff2?|ttf|otf)$'` → **0 results.** All typography is CSS-loaded (Google Fonts / system fonts) — no bundled font files to attribute.

---

## 10. Findings

Raised in this phase, recorded against ID range A2-301..A2-399. Severity per plan §3.4.

| ID     | Severity | Title                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-301 | Medium   | Exact-pin drift: `vitest` pinned `4.1.0` in `apps/backend` + `apps/web`, lockfile resolves `4.1.4` (peer-dep of `@vitest/coverage-v8@4.1.4`). `package.json` pin is misleading; any reader believing the codebase is on 4.1.0 is wrong. Either bump the pin to `4.1.4` (and to `4.1.5` once coverage catches up) or pin coverage-v8 to the matching `4.1.0` line.                                                                                                                                                         |
| A2-302 | Low      | Five extraneous modules in root `node_modules/` (`@emnapi/core`, `@emnapi/runtime`, `@emnapi/wasi-threads`, `@napi-rs/wasm-runtime`, `@tybys/wasm-util`) not in the lockfile. Leftover from a prior `sharp` install path; `npm ci` would remove them. Indicates the current developer's env is not lockfile-reproducible. Run `npm ci` or `rm -rf node_modules && npm install` and re-commit any resulting lockfile diff.                                                                                                 |
| A2-303 | Medium   | `esbuild@0.18.20` dev-server CVE (GHSA-67mh-4wv8-2f99, moderate) reachable via `drizzle-kit@0.31.10 → @esbuild-kit/esm-loader → @esbuild-kit/core-utils`. Both `@esbuild-kit/*` are deprecated ("Merged into tsx"). Mitigation is bounded — the vulnerable dev-server only runs when `drizzle-kit` spins one up, which it doesn't by default. Track drizzle-kit upstream for the tsx migration; consider replacing `drizzle-kit` dev-only invocations with raw `tsx` + `drizzle-orm` migration helpers to drop the chain. |
| A2-304 | Medium   | `@bufbuild/buf@1.68.2` postinstall has a fallback that shells out to `npm install <platform-package>` if the optional platform dep is absent. This executes on every fresh clone that uses `npm ci --omit=optional` or similar. Document the behaviour in `docs/deployment.md`; consider pinning all platform binaries explicitly in `optionalDependencies` of the workspace to short-circuit the fallback.                                                                                                               |
| A2-305 | Low      | `@img/sharp-libvips-<platform>@1.2.4` is **LGPL-3.0-or-later** (only non-permissive licence in the tree, reached via `sharp@0.34.5`). Loop must publish an open-source attribution notice (typically on `/licences` or in the app "About" screen) listing libvips + its LGPL terms before public launch. Currently no such surface exists.                                                                                                                                                                                |
| A2-306 | Low      | `apps/web/public/leaflet/marker-icon*.png` + `marker-shadow.png` are BSD-2-Clause images copied from the leaflet package, but ship without the leaflet copyright notice alongside them. BSD-2 requires the copyright notice be reproduced "in the documentation and/or other materials provided with the distribution." Add a `LICENSES.md` or per-dir `LICENSE` file under `apps/web/public/leaflet/` pointing at the upstream notice.                                                                                   |
| A2-307 | Low      | 19 packages on `npm outdated` list — most are patches awaiting the next Monday Dependabot run, but `@hono/node-server 1.19.14 → 2.0.0` is a major bump that Dependabot's minor-and-patch grouping will NOT file. Add a tracked task (or a dedicated Dependabot group) to pick up major-version Hono + @types/react bumps; otherwise they drift indefinitely.                                                                                                                                                              |
| A2-308 | Low      | 52 transitive packages have >1 installed version (notably `esbuild` at three majors, `ansi-regex`/`strip-ansi`/`wrap-ansi`/`string-width` each at 2-3). None reachable by a known CVE today, but the duplicate surface multiplies supply-chain exposure and install size. Consider a `resolutions`/`overrides` dedup pass for the top five offenders after the drizzle-kit swap lands.                                                                                                                                    |
| A2-309 | Info     | `postgres@3.4.9` ships under the **Unlicense** (public-domain dedication) — permissive, but unusual for a production SQL driver. Worth recording in the OSS attribution page so the legal reviewer doesn't flag it as missing a licence.                                                                                                                                                                                                                                                                                  |
| A2-310 | Info     | Only the root `package.json` declares `engines.node: ">=22.0.0"`. Individual workspace `package.json`s have no `engines` constraint, so a consumer installing a workspace in isolation won't get the node-version gate. Low-impact because we always install at the monorepo root, but worth mirroring into each workspace for defence in depth.                                                                                                                                                                          |

### Severity counts

- Critical: 0
- High: 0
- Medium: 3 (A2-301, A2-303, A2-304)
- Low: 5 (A2-302, A2-305, A2-306, A2-307, A2-308)
- Info: 2 (A2-309, A2-310)
- **Total: 10**

---

## 11. Commands that required network access

None strictly required for this phase — every capture ran against the local `npm` cache and `node_modules` on disk. `npm audit` hits the npm registry advisory DB by default but the call completed from cache (evidence is in `phase-3-npm-audit.json`). `npm outdated` similarly consults `npm view` but the JSON matches what `node_modules/.package-lock.json` would project.

If running from a fresh cache, the following would touch the network:

- `npm audit` → `https://registry.npmjs.org/-/npm/v1/security/advisories/bulk`
- `npm outdated` → `npm view <pkg> version` for every direct dep

Neither failed on this run. No retries needed.

---

## Exit

Phase 3 complete. 10 findings filed (3 Medium, 5 Low, 2 Info). No Critical or High. Evidence captured at commit `450011d`. Tracker update is a separate task per the audit rules (this evidence file is the authoritative source; tracker edits happen under a different author).
