# 002 — TypeScript over Go for the backend

## Status
Accepted

## Date
2026-03-05

## Context
The Loop backend needs to serve map clustering, merchant data, image proxying, auth, and (in Phase 2) Stellar wallet operations. An existing Go clustering service existed as a reference implementation, but the question was whether to continue in Go or write the Loop backend in TypeScript.

The clustering algorithm is ~400 lines of pure arithmetic with no language-specific idioms that would be hard to express in TypeScript.

## Decision
Write `apps/backend` in TypeScript using the Hono framework.

## Consequences

**Benefits:**
- Single language across the entire monorepo — one toolchain, one linting config, one CI pipeline
- Shared types in `packages/shared/` are usable by `apps/web`, `apps/mobile`, and `apps/backend` simultaneously — type mismatches between API contract and client are caught at compile time rather than at runtime
- `sharp` (the TypeScript image processing library) is faster than the Go equivalent for most resize operations due to its libvips backend, and is already present in the existing web app dependencies
- `@bufbuild/protobuf` with `buf` code generation provides type-safe protobuf in TypeScript, with the `.proto` schema as the single source of truth
- Node.js is single-threaded — the atomic hot-swap pattern needed in Go for concurrent access becomes a plain variable reassignment

**Trade-offs:**
- Porting the clustering logic from Go to TypeScript introduces a risk of behavioural differences — mitigated by writing a comparison test that verifies identical output for identical input
- Go has better raw CPU performance. For this workload (in-memory filtering and grid arithmetic on ~35k points), Node.js performs comparably — the existing Go service benchmarks at sub-50ms; the TypeScript port targets the same
