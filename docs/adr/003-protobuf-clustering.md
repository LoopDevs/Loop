# 003 — Protobuf for the clustering endpoint

## Status

Accepted

## Date

2026-03-05

## Context

The `/api/clusters` endpoint returns geographic cluster data used by the map view. At zoom levels showing individual merchant pins, a typical viewport returns 200–800 location points. At low zoom levels, 200–500 cluster aggregates are returned.

The existing web app already uses protobuf for the map clustering endpoint via `protobufjs` with an inline schema string. The question was whether to keep protobuf in the Loop backend rewrite or simplify to JSON only.

## Decision

Keep protobuf support for the clustering endpoint using `@bufbuild/protobuf` with types generated from `clustering.proto` into `packages/shared/`. Both the web app and mobile app request protobuf via `Accept: application/x-protobuf` in production. JSON remains available as a fallback for debugging.

## Consequences

**Benefits:**

- ~20–40% bandwidth reduction on real-world gzip-compressed payloads
- More meaningful on poor mobile data connections, which is a realistic scenario for a mobile app used in shops and streets
- Maintaining existing behaviour in the rewrite is lower risk than removing and re-adding later
- `@bufbuild/protobuf` with `buf` code generation gives type-safe shared types across client and server — an improvement over the previous inline schema string approach, where client and server could silently diverge
- OTA updates to the mobile app can push new protobuf schema alongside updated client code, preventing version skew

**Trade-offs:**

- Binary responses are harder to inspect during development — mitigated by JSON fallback
- Requires `buf` toolchain for code generation — minor CI dependency
- Schema changes require regenerating types and coordinating client + server updates — mitigated by shared types in `packages/shared/` making contract mismatches a compile error rather than a runtime failure
