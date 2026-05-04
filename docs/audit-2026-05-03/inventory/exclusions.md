# Exclusions

This audit is comprehensive for tracked repository files. Exclusions apply only to files that are not meaningful source-of-truth for the audit or cannot be reviewed safely as raw artifacts.

## Default Excluded Runtime and Dependency Output

The workspace inventory excludes:

- `node_modules/**`
- `apps/mobile/node_modules/**`
- `dist/**`
- `build/**`
- `coverage/**`
- `playwright-report/**`
- `test-results/**`
- Android Gradle cache/build output under generated native projects
- iOS copied static web output under generated native projects when it is build output

## Generated or Binary Files Still In Scope

Generated or binary files that are tracked are still in scope unless explicitly dispositioned:

- `package-lock.json`
- generated protobuf files
- Drizzle migration metadata snapshots
- tracked mobile native projects and overlays
- tracked splash/icon/marker/hero image assets
- public SVGs and manifests
- fixtures used by tests

Review method may differ. Binary and generated files can be reviewed through metadata, source-of-truth comparison, checksums, generation commands, image inspection, or config comparison.

## Prior Audit Material

Prior audit files are in scope as documentation truth and historical artifacts. They are not evidence for current findings. A current finding can reference a prior audit file only to show that stale or misleading documentation exists.

## External Systems

The audit does not inspect CTX, Stellar, Fly.io, GitHub, Apple, Google, npm, or Android internals. It does inspect Loop-owned configuration, assumptions, validation, permissions, docs, tests, and failure behavior around those systems.
