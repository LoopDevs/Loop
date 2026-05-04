# Phase 16 - Shared Contracts and Serialization

Status: in-progress

Required evidence:

- shared export inventory: captured from `packages/shared/src/index.ts` and `packages/shared/AGENTS.md`
- backend producer and web consumer matrix: started with admin response-shape pairs
- OpenAPI and error code reconciliation: route parity captured; response/status drift remains under filed findings
- proto source/output review: pending deeper pass
- enum/state exhaustiveness review: pending deeper pass

Findings:

- A4-028 - admin wire response shapes duplicated outside `@loop/shared`
- A4-029 - cluster protobuf path disabled by protobuf-es v2 API mismatch

Evidence captured:

- [admin-wire-shapes-outside-shared.txt](./artifacts/admin-wire-shapes-outside-shared.txt)
- [protobuf-runtime-disabled.txt](./artifacts/protobuf-runtime-disabled.txt)
- [openapi-route-parity.txt](./artifacts/openapi-route-parity.txt)

Current verified observations:

- `packages/shared` has a strict no-duplication policy for code used by both web and backend, and `src/index.ts` already centralizes many public/user/admin contracts.
- Several current admin service files still define response-body interfaces locally in the web app while equivalent backend handlers independently define the produced response shape.
- This is not limited to one endpoint family. Verified examples include admin activity time series, payment-method share, and admin users directory/detail.
- The same "do not promote to @loop/shared" rationale appears in multiple web service modules even though these are backend-produced, web-consumed wire contracts.
- Protobuf generation currently emits schema descriptors, while backend/web cluster code expects a class-style `ProtobufClusterResponse`; the `Accept: application/x-protobuf` path falls back to JSON and tests allow that fallback.
- OpenAPI route parity scanner found 135 `registerPath` entries matching all non-introspection runtime routes after parameter normalization; the only runtime route outside OpenAPI is `GET /openapi.json` itself.
- OpenAPI drift is not eliminated by route parity: A4-004, A4-014, and A4-016 remain open for lint coverage and response/status/schema mismatches.
