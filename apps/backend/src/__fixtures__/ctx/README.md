# CTX upstream contract fixtures (A2-1706)

These JSON files capture **representative** responses from the
upstream CTX API per endpoint we proxy. The contract test
(`apps/backend/src/__tests__/ctx-contract.test.ts`) parses each one
through the matching Zod schema and fails CI when the schema can no
longer accept the recorded shape — i.e. someone has narrowed our
schema in a way that's incompatible with the real upstream, or
they've widened the schema in a way that's no longer matched at
runtime by what CTX sends.

The opposite direction — CTX itself drifting — is detected at
runtime by the existing Zod gates inside the proxy handlers + the
`e2e-real.yml` workflow that hits real CTX. This contract test is
the **PR-time** detector for **our-side** drift; it's intentionally
not a live-CTX integration test.

## When to refresh a fixture

Refresh a fixture when:

- CTX informs us of an upcoming response-shape change
  (deprecation / new field / type narrowing) and we want to
  pre-stage the schema migration
- A real-traffic Zod failure surfaces in the backend (Sentry
  `area: 'ctx-zod'` log line) and we discover the fixture is stale
- A `e2e-real.yml` run fails on a shape mismatch the contract test
  didn't catch — pull the failing payload, scrub PII / secrets, and
  drop into the fixture file

## Refresh procedure

1. Capture a real response. Easiest: tail the backend's pino
   `area: 'ctx-upstream-body'` log line during a real-CTX session
   (e.g. while running `npm run test:e2e:real`). Copy the body JSON.
2. **Scrub.** Replace tokens, refresh tokens, real merchant IDs that
   reveal commercial relationships, and any user PII with synthetic
   placeholders. The fixture is checked into a public repo — treat
   it like example documentation, not production data.
3. Replace the matching `*.json` file. Keep the file's top-level
   shape — the contract test loops the directory and matches each
   file by **filename** to the right schema.
4. Run `npm test -- ctx-contract` to confirm it parses.

## Files

| Filename                       | Schema                        | Surface                                                |
| ------------------------------ | ----------------------------- | ------------------------------------------------------ |
| `verify-otp-response.json`     | `VerifyOtpUpstreamResponse`   | `POST /verify-email` (token issuance)                  |
| `refresh-token-response.json`  | `RefreshUpstreamResponse`     | `POST /refresh-token` (rotated access + refresh token) |
| `merchants-list-response.json` | `UpstreamListResponseSchema`  | `GET /merchants` (paginated catalog list)              |
| `merchant-item.json`           | `UpstreamMerchantSchema`      | A single merchant from the `result[]` array            |
| `create-order-response.json`   | `CreateOrderUpstreamResponse` | `POST /gift-cards` (order creation)                    |
| `get-order-response.json`      | `GetOrderUpstreamResponse`    | `GET /gift-cards/:id` (single order detail)            |
| `list-orders-response.json`    | `ListOrdersUpstreamResponse`  | `GET /gift-cards` (paginated user-orders)              |
