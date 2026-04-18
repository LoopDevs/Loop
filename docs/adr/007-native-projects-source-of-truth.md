# ADR-007: Native iOS/Android projects — overlays over versioning

- **Status**: Accepted
- **Date**: 2026-04-18
- **Deciders**: Engineering
- **Supersedes**: —
- **Superseded by**: —
- **Closes**: Audit A-012

## Context

Audit A-012 flagged that `apps/mobile/ios/` and `apps/mobile/android/`
are in `.gitignore`, so the mobile release surface is not versioned
or auditable from the repo itself. The audit offered two routes:

1. **Version them** — commit the entire generated Capacitor project
   tree, treating native files as product source of truth.
2. **Document the generation / configuration process** — keep them
   generated, but version any config that needs to survive
   regeneration and audit the generated state separately.

## Decision

Choose route 2: keep the native directories gitignored, but make the
regeneration process deterministic and the required configuration
versioned.

The fully generated state of the two native trees is ~942 files and
52 MB at the time of writing, dominated by Gradle and Xcode artefacts
(build caches, compiled Pod binaries) that `cap sync` regenerates on
every update. Versioning the full tree would:

- Bloat diffs on every Capacitor version bump.
- Drag build artefacts into PR review.
- Require a lockfile-style merge strategy every time two developers
  added a plugin in parallel.

What actually needs to be reproducible is the **configuration on
top** of the generated tree. That is now fully versioned:

- **`apps/mobile/native-overlays/`** — all config that `cap sync`
  would otherwise overwrite:
  - `android/.../xml/backup_rules.xml` (audit A-033)
  - `android/.../xml/data_extraction_rules.xml` (audit A-033)
  - `ios/.../Info.plist.additions.txt` (audit A-034)
- **`apps/mobile/scripts/apply-native-overlays.sh`** — the idempotent
  script that lays the overlays into the generated trees and patches
  the manifest. Part of the bootstrap flow in `docs/development.md`.
- **`apps/mobile/capacitor.config.ts`** — already versioned. Holds
  the bundle id, app name, plugin config, and server-url dev
  overrides.
- **`apps/web/package.json`** — plugin set is versioned. `cap sync`
  picks up every installed `@capacitor/*` and `@aparajita/*` plugin
  from there.

Bootstrap flow for a fresh clone:

```
npm install                                        # pulls plugins
cd apps/web && npm run build:mobile                # static web build
cd apps/mobile
npx cap add ios && npx cap add android             # regen native trees
./scripts/apply-native-overlays.sh                 # re-apply our config
npx cap sync                                       # wire the web build in
```

Each step is deterministic. The `cap sync` output is reproducible
from the versioned inputs, modulo what Capacitor itself changes
between versions (which is captured in our Capacitor dependency
version in `package.json`).

### What we audit separately for the generated state

The gap this ADR doesn't fully close is that the _runtime_ state of
the native projects on a build machine isn't reviewed in PR diffs.
That risk is mitigated by:

- Store metadata (bundle id, usage descriptions, permissions) being
  locked to versioned files the overlay script enforces.
- The App Store / Play Console review process — any change to the
  submitted binary's capabilities or entitlements is flagged by the
  store review team before a build ships.
- Manual pre-release checks captured in `docs/mobile-native-ux.md`
  §Native-config overlays.

If that mitigation ever feels insufficient — for example, if we add
a platform that doesn't go through a store review and therefore
lacks the external audit trail — we revisit and version the full
native tree at that point.

## Consequences

- **The gitignore stays as-is.** `apps/mobile/ios/` and
  `apps/mobile/android/` remain generated-on-clone artefacts.
- **The overlay system is authoritative.** Any config that must
  survive `cap sync` lives in `apps/mobile/native-overlays/` and is
  re-applied by the overlay script. PR-review visibility of native
  config deltas happens via those overlay files, not via native
  project file diffs.
- **Bootstrap docs are load-bearing.** `docs/development.md` and
  `docs/mobile-native-ux.md` must stay accurate; if the bootstrap
  flow drifts, fresh clones won't produce a working mobile build.
  The PR template includes a check for docs drift on any change
  touching mobile config.
- **Revisit trigger.** If we add a native build path that bypasses
  store review (side-loaded Android, enterprise iOS, Fastlane-only
  flows without manual audit), we re-open this ADR and version the
  full tree at that point.

## Related

- Audit A-012 — this ADR closes the finding.
- Audit A-033 — Android backup exclusions (overlay).
- Audit A-034 — iOS `NSFaceIDUsageDescription` (overlay).
- `apps/mobile/native-overlays/` — canonical config source.
- `apps/mobile/scripts/apply-native-overlays.sh` — applicator.
- `docs/mobile-native-ux.md` §Native-config overlays — contributor
  runbook for the overlay system.
