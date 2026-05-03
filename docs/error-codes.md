# Error-code taxonomy

Single source of truth for every `{ code, message }` response the
Loop backend emits. Kept in sync with `packages/shared/src/api.ts`
(`ApiErrorCode` enum) — the enum is the TypeScript surface, this
doc is the operator + integrator reference.

Closes A2-1011. Previously, handlers shipped codes ad-hoc and
client switch-ladders tracked drift informally in code review.

## How to read the table

- **Code** — the literal string in the response body's `code` field.
- **Status** — the HTTP status the handler pairs with it. A client
  should branch on `code`, not status — multiple codes can share a
  status (e.g. several 400s), and status alone is coarser than
  needed for UX branching.
- **Where** — the handler families that emit it. Not exhaustive;
  `grep "code: 'X'"` gives the current list.
- **Client guidance** — what the web / mobile UX is expected to do
  when it receives this code. "Retryable" = safe to try again after
  some backoff; "terminal" = don't retry without fixing input /
  state first.

## Request-validation family (400)

| Code                       | Status | Where                                                   | Client guidance                                                                                                                  |
| -------------------------- | ------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`         | 400    | Every handler — generic body / param / query validation | Terminal. Surface `message` to the user; fix input before retry.                                                                 |
| `IDEMPOTENCY_KEY_REQUIRED` | 400    | All admin writes (ADR 017)                              | Terminal. The client is missing the `Idempotency-Key` header or sent one outside the 16-128 char range. Generate a UUID + retry. |
| `HOME_CURRENCY_LOCKED`     | 409    | `POST /api/users/me/home-currency` after first order    | Terminal. User placed an order; support must unlock. Surface the "contact support" path.                                         |
| `INSUFFICIENT_CREDIT`      | 400    | `POST /api/orders/loop` with `paymentMethod=credit`     | Terminal. User's cashback balance is below the order amount. Prompt them to top up via another method.                           |
| `INSUFFICIENT_BALANCE`     | 400    | `POST /api/admin/users/:userId/withdrawals` (ADR-024)   | Terminal. Admin attempted a withdrawal larger than the user's balance — message carries available vs requested.                  |
| `REFUND_ALREADY_ISSUED`    | 409    | `POST /api/admin/users/:userId/refunds`                 | Terminal. DB partial unique index caught a duplicate refund for the same order. Surface the existing refund's id.                |
| `PAYLOAD_TOO_LARGE`        | 413    | bodyLimit middleware (A2-1005)                          | Terminal. Body exceeded 1 MB. Client should split the payload.                                                                   |

## Auth family (401 / 403 / 404)

| Code           | Status | Where                                                                                                                                 | Client guidance                                                                                                                          |
| -------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `UNAUTHORIZED` | 401    | `requireAuth` middleware, admin handlers without actor context                                                                        | Retryable after re-auth. Trigger refresh-token rotation, then retry once. If still 401, sign the user out.                               |
| `NOT_FOUND`    | 404    | Merchant / order / payout not found. Also: feature-flag-off (`LOOP_AUTH_NATIVE_ENABLED=false` surfaces the Loop-native routes as 404) | Terminal. Don't retry — the resource doesn't exist or the caller isn't authorised to see it (enumeration-defence masks the distinction). |

## Resource-state family (409)

| Code                        | Status | Where                                                                                     | Client guidance                                                                                                   |
| --------------------------- | ------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ALREADY_COMPENSATED`       | 409    | `POST /api/admin/payouts/:id/compensate` (ADR-024 §5)                                     | Terminal. The failed payout already has a compensation marker; don't compensate it again.                         |
| `PAYOUT_NOT_COMPENSABLE`    | 409    | Same endpoint — payout is `kind='order_cashback'` or not currently a retryable failed row | Terminal. Compensation is strictly for failed withdrawal payouts.                                                 |
| `WITHDRAWAL_ALREADY_ISSUED` | 409    | `POST /api/admin/users/:userId/withdrawals` (ADR-024)                                     | Terminal for the attempted duplicate. Reuse or resolve the existing active withdrawal instead of issuing another. |
| `PENDING_PAYOUTS`           | 409    | `POST /api/users/me/dsr/delete` while cashback payout rows are still pending/submitted    | Terminal until the payout settles or support intervenes.                                                          |
| `IN_FLIGHT_ORDERS`          | 409    | `POST /api/users/me/dsr/delete` while an order is still pending/paid/procuring            | Terminal until fulfilment or expiry completes.                                                                    |

## Rate-limit family (429)

| Code                   | Status | Where                                                                                      | Client guidance                                                                                                                                   |
| ---------------------- | ------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RATE_LIMITED`         | 429    | Every rate-limited route (see AGENTS.md middleware stack entry #6)                         | Retryable. Respect `Retry-After`. The limiter uses a fixed-window counter per IP — a burst that hits the limit waits the remainder of the window. |
| `DAILY_LIMIT_EXCEEDED` | 429    | `POST /api/admin/users/:userId/credit-adjustments` business-rule cap on signed adjustments | Terminal for the current UTC day unless an operator raises the cap; retrying the same write will not help.                                        |

## Image-proxy family (413 / 502)

| Code                | Status | Where                                                                  | Client guidance                                                                          |
| ------------------- | ------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `IMAGE_TOO_LARGE`   | 413    | `GET /api/image` — upstream response > 10 MB                           | Terminal. The source is oversized; the client should not retry with the same URL.        |
| `NOT_AN_IMAGE`      | 502    | `GET /api/image` — upstream returned a non-`image/*` Content-Type      | Terminal. The URL didn't point at an image (or the upstream's `Content-Type` was wrong). |
| `UPSTREAM_REDIRECT` | 502    | `GET /api/image` — upstream returned a 3xx (not followed; SSRF-safety) | Terminal. The original URL is stale.                                                     |

## Upstream family (502 / 503)

| Code                     | Status | Where                                                                                                  | Client guidance                                                                                                                  |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `UPSTREAM_ERROR`         | 502    | Every CTX-proxying handler when the upstream returned a non-auth non-5xx but the response didn't parse | Retryable with backoff (human-scale — upstream shape drift is an ops-level issue, not a flaky-network issue).                    |
| `UPSTREAM_UNAVAILABLE`   | 503    | Upstream circuit-breaker is open                                                                       | Retryable. Cooldown window typically < 1 min.                                                                                    |
| `SERVICE_UNAVAILABLE`    | 503    | `verify-otp`/`refresh` on proxy-path circuit-open; social-login JWKS/anti-replay infra degradation     | Retryable with backoff (minutes, not seconds). The breaker cooldown window is 30s; social-login 503s are provider/infra outages. |
| `SUBSYSTEM_DISABLED`     | 503    | Runtime kill switch on `auth`, `orders`, or `withdrawals` surfaces                                     | Retryable only after operators reopen the subsystem. Honour `Retry-After` when present.                                          |
| `NOT_CONFIGURED`         | 503    | Required server config missing, including admin withdrawals without a configured LOOP issuer           | Retryable after ops fixes configuration. Not a user-input problem.                                                               |
| `WEBHOOK_NOT_CONFIGURED` | 503    | `POST /api/admin/discord/config/*/test` when the target webhook env var is unset                       | Retryable after ops sets the webhook URL.                                                                                        |
| `INTERNAL_ERROR`         | 500    | The catch-all. Indicates a bug — ops should be paged.                                                  | Retryable once; if it repeats, surface "we hit an issue, please try again in a bit" rather than a technical message.             |

## Client-only codes (never sent by the backend)

Two entries on the shared enum exist for the client's own fetch
layer so its error path carries the same switch-ladder shape:

- `NETWORK_ERROR` — transport-level failure (DNS, connection refused).
- `TIMEOUT` — client-side `AbortSignal.timeout` tripped.

## Adding a new code

1. Add the literal to `ApiErrorCode` in `packages/shared/src/api.ts` — grouped under the appropriate category comment block, with a trailing inline comment if the handler-side rationale isn't obvious.
2. Emit it from the handler as `{ code: 'XYZ', message: '...' }` paired with an HTTP status consistent with its row in this table (or add a new row if it's a new family).
3. Register the response in `apps/backend/src/openapi.ts` against the endpoint — status code, ErrorResponse schema, description that names the code literal. The A2-1507 drift check (`scripts/lint-docs.sh` §9) catches handlers that ship without openapi registration.
4. Update this doc. A missing row here is a tracker-sweep item waiting to happen.
