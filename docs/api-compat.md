# `/api/*` backward-compatibility contract

The backend exposes two distinct surfaces with very different compatibility commitments. Conflating them in a single versioning policy hurts both — this doc separates them.

Closes A2-1530. Prior to this doc the mobile-binary / web-bundle contract was informal and nothing in review caught a breaking shape change before it shipped.

## Surface map

| Path prefix                                                                                       | Consumers                                                | Contract                          |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------- |
| `/api/auth/*`                                                                                     | Web bundle + mobile binary (Capacitor webview)           | **Strict** — see below            |
| `/api/orders*`, `/api/users/me*`, `/api/merchants*`, `/api/clusters`, `/api/image`, `/api/config` | Web bundle + mobile binary                               | **Strict**                        |
| `/api/admin/*`                                                                                    | Web bundle (admin shell) only, gated by `isAdmin`        | **Web-linked**                    |
| `/api/public/*`                                                                                   | Loopfinance.io marketing surface + any third-party embed | **Strict + cache-safe** (ADR 020) |
| `/openapi.json`, `/metrics`, `/health`                                                            | Dev tooling, Prometheus scraper, Fly healthcheck         | Not versioned                     |

## Strict contract (user-facing endpoints)

A strict endpoint is one whose response shape and HTTP-code surface a shipped mobile binary depends on. Mobile versions stay installed for months — an App Store update is an opt-in action and many users delay it indefinitely.

**Allowed without a version bump:**

- Add a new optional response field. Clients that don't read it are unaffected.
- Add a new value to an open-ended string enum (e.g. a new OrderState variant) — **only if** every shipped client has been audited for exhaustive switches that assertNever-fail on unknown values. The A2-1532 ESLint rule + A2-1531 LoopOrdersList switch are examples of what "audited" means. When in doubt, treat it as a breaking change.
- Add a new endpoint under an existing path.
- Add new error codes under existing HTTP statuses (the `{ code, message }` envelope is stable; new `code` values are additive).
- Add new required headers that older clients already send (`X-Client-Version` is stamped on every request — see A2-1529).

**NOT allowed without a parallel-run migration:**

- Rename or remove a response field.
- Tighten a nullable field to non-nullable, or vice-versa.
- Change a field's type (string → number, number → string).
- Shrink an enum (remove a state variant).
- Remove an endpoint or change its path.
- Remove an error code that existed historically — clients may be switching on it.
- Change the HTTP status paired with an existing error code.

**Parallel-run migration** means:

1. Introduce the new shape alongside the old. New endpoint, new query param, or a `?v=2` flag.
2. Wait until telemetry shows the last version of the mobile binary consuming the OLD shape is past its sunset window (typically 180 days from the binary release).
3. Remove the old shape.

We don't have a formal sunset policy yet — when this doc is revisited (before Phase 2), set a concrete sunset window and an operator-visible dashboard of in-the-wild client versions (the `X-Client-Version` log field is the input).

## Web-linked contract (`/api/admin/*`)

Admin routes are consumed only by the web bundle. A web-bundle deploy goes out globally at once — no stale admin client to worry about. The contract is **same-commit consistency**: the web build that ships from commit C must match the backend that ships from commit C. Shape changes here are allowed without a deprecation cycle as long as:

- The matching change lands in `apps/web/app/services/admin.ts` in the same PR.
- `scripts/lint-docs.sh §9` (A2-1507) passes — `openapi.ts` registration agrees with the handler.

The admin panel never gets cached by service workers and always re-fetches on login, so a mid-deploy user sees the new shape within a page refresh.

## Public-API contract (`/api/public/*`)

`/api/public/*` endpoints are never-500, cache-safe, and PII-free per ADR 020. Beyond the strict rules above:

- Responses carry `Cache-Control` headers that a CDN can honour. Changing `Cache-Control` semantics is a breaking change for intermediaries.
- Adding a new field is safe but the field should never carry PII — future consumers may include third parties whose privacy story Loop has no visibility into.

## How this interacts with other audit items

- **A2-1507 OpenAPI drift check** (shipped): `scripts/lint-docs.sh §9` catches handler-side changes without matching `openapi.ts` registration. This is the enforcement layer for the strict contract on the backend side.
- **A2-1529 X-Client-Version header** (shipped): every request carries the client's build version, forwarded to the access log (`apps/backend/src/app.ts:388-412`). This is the telemetry input for the sunset-window check above.
- **A2-1504 / A2-1505 / A2-1506 shared wire shapes**: moving response types into `@loop/shared` means web and backend compile against the same definition — a rename that would break the contract fails typecheck on both sides in the same PR.

## How to break the contract deliberately

When a shipped client truly needs to move off a legacy shape:

1. Write an ADR explaining the motivation, the parallel-run window, and the sunset trigger (typically a minimum installed-version floor).
2. Add the new shape.
3. Add a deprecation warning to the old shape's access log line so operators can see how much traffic still reads it.
4. Ship the mobile / web update that consumes the new shape.
5. Wait for the sunset trigger.
6. Delete the old shape in a follow-up PR that cites the ADR and the telemetry decision to cut.

Phase 1 hasn't needed this yet. Phase 2's stablecoin migration (ADR 015) will be the first real test — the home-currency split changes response shapes for historical orders, and a v1 / v2 parallel run may be warranted.
