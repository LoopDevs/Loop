# V12 — Shared Package + Type-Contract Integrity — Cold Audit (2026-06-15)

Vertical owner: `packages/shared/src/**` (37 files) + the parity gates
(`scripts/check-shared-type-parity.mjs` + allowlist,
`scripts/check-openapi-parity.mjs` + allowlist) cross-checked against
`apps/backend/src/openapi.ts` / `openapi/**`, the Drizzle CHECK constraints in
`apps/backend/src/db/schema.ts`, the proto source
`apps/backend/proto/clustering.proto`, and web consumption.

Applied: ADR 019 (three-part test, re-export rule, phased adoption / parity),
type-contract integrity (web↔backend↔shared↔openapi↔proto), correctness
(slugs country-awareness, money minor-units/rounding, countries/regions vs
ADR 034/035, state enums vs DB), proto drift, test meaningfulness, DRY, docs.

## Coverage

Every shared source file read in full (37/37) plus both parity-gate scripts,
both allowlists, the `.proto` source + generated `clustering_pb.ts`, the five DB
CHECK constraints that mirror shared enums, and a sample of openapi schema files
(`orders-loop-reads.ts`, `orders-loop.ts`, `treasury.ts` re-exports) to confirm
shared↔openapi alignment.

| File                                               | Status           | Notes                                                                                                                                                                           |
| -------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                                         | OK               | barrel exports all 33 non-test/non-proto source modules; verified none missing                                                                                                  |
| `api.ts`                                           | OK               | `ApiErrorCode` is the single error-code source; backend openapi imports it. `RefreshResponse` removal documented                                                                |
| `slugs.ts` + `slugs.test.ts`                       | OK               | country-aware `merchantSlug` vs country-agnostic `brandSlug` correct; uniqueness-per-(brand,country) invariant well-tested incl. the true-dupe collision case. Tests meaningful |
| `merchant-groups.ts` + `.test.ts`                  | OK               | country-agnostic grouping ↔ country-aware slug seam tested explicitly (the load-bearing ADR 032 case). Meaningful                                                               |
| `money-format.ts`                                  | **FINDING (P2)** | `formatMinorCurrency` loses precision past 2^53 major units, contradicting its own "never relies on it" docstring                                                               |
| `countries.ts`                                     | OK (P3 note)     | ADR 034 + 035 markets complete; `merchantInCountry` data-gap fallback correct                                                                                                   |
| `regions.ts`                                       | OK (P3 note)     | superseded-but-live; `Region.currency` narrower union than `SupportedCurrency` (intentional, vestigial)                                                                         |
| `order-state.ts`                                   | OK               | `ORDER_STATES` + `ORDER_PAYMENT_METHODS` exactly match DB CHECKs                                                                                                                |
| `payout-state.ts`                                  | OK               | matches `pending_payouts_state_known`                                                                                                                                           |
| `credit-transaction-type.ts`                       | OK               | matches `credit_transactions_type_known`                                                                                                                                        |
| `loop-asset.ts`                                    | OK               | `HOME_CURRENCIES`/`LOOP_ASSET_CODES` 1:1 maps total; match `users_home_currency_known`. Strong type-safety                                                                      |
| `loop-orders.ts`                                   | OK               | discriminated union on `payment.method`; backend handler return-typed to `LoopOrderView`                                                                                        |
| `orders.ts`                                        | **FINDING (P3)** | docstring describes Loop-native states as `created→paid→fulfilled→settled` — no such states exist                                                                               |
| `merchants.ts`                                     | OK               | core wire types; `slug?` optional documented                                                                                                                                    |
| `users-me.ts`                                      | OK               | 13 `/me*` shapes; `homeCurrency` typed `HomeCurrency` (fixed prior drift)                                                                                                       |
| `stellar.ts`                                       | OK               | single `STELLAR_PUBKEY_REGEX`; rejects muxed by design                                                                                                                          |
| `search.ts`                                        | OK               | `foldForSearch` shared by backend `?q=` + web navbar                                                                                                                            |
| `cashback-realization.ts`                          | OK               | `recycledBps` pure bigint, div-by-zero + clamp correct                                                                                                                          |
| `assert-never.ts`                                  | OK               | throws at runtime + compile-time exhaustiveness                                                                                                                                 |
| `public-*.ts` (6)                                  | OK               | ADR 020 narrow no-PII shapes; `LoopAssetCode` reused not hardcoded                                                                                                              |
| `admin-*.ts` (7)                                   | OK               | A2-1506 consolidations; re-exported both sides                                                                                                                                  |
| `user-favorites.ts` / `user-recently-purchased.ts` | OK               | ADR 019 two-consumer promotions                                                                                                                                                 |
| `proto/clustering_pb.ts`                           | OK (P3 note)     | field numbers/names match `.proto`; generator v2.11.0 vs dep 2.12.0 skew                                                                                                        |
| parity gates + allowlists                          | **FINDING (P2)** | no field-level shared↔openapi enforcement; openapi zod hand-rolled                                                                                                              |
| `AGENTS.md` Files table                            | OK               | all 37 files listed accurately                                                                                                                                                  |

Both parity gates pass at audit time: `shared-type-parity: OK` (61 allowlisted
collisions), `openapi-parity: OK` (144 mounts ↔ 144 registrations).

## Findings

### P2-SHARED-01 — `formatMinorCurrency` silently mis-renders fleet-wide totals past 2^53 (docstring is false)

- **Severity:** P2 (Medium) — incorrect money display on aggregate surfaces; not money-loss (display only), and the threshold ($90T+) is implausible near-launch, but the helper's docstring actively claims safety it does not have.
- **File:** `packages/shared/src/money-format.ts:54-72`
- **Evidence:** The docstring (lines 36-39) states "the helper never relies on it [the 2^53 window] — the Number cast only touches the whole/frac components after the bigint split." But the implementation does `const major = Number(abs / 100n)` then `(neg?-1:1)*(major+frac)` and feeds a single `number` to `Intl.NumberFormat`. `major` is a `number`, so any value where `abs/100n > 2^53` loses precision. Probed: `formatMinorCurrency("900719925474099300","USD")` → `$9,007,199,254,740,992.00` (off by 100), and `formatMinorCurrency("9999999999999999999","USD")` → `$100,000,000,000,000,000.00` (grossly wrong). Renders silently — no `NaN`, no throw.
- **Impact:** Fleet-wide consumers (`FleetFlywheelHeadline`, `CashbackRealizationCard`, `SupplierSpendCard`, treasury, `CashbackSummaryChip` lifetime) — the exact "2^53 overflow" case the module header lists as its reason for existing — would silently display a wrong total once a fiat minor-unit sum exceeds ~9e15 (≈ $90 trillion in cents). The whole point of the bigint helper is defeated for its headline use case.
- **Fix:** Format from the bigint directly without an intermediate `number` for the whole part. Build the integer-string of major units (`(abs/100n).toString()`), group with `Intl.NumberFormat('en-US',{useGrouping:true})` over the bigint or via manual 3-digit grouping, append `.${(abs%100n).toString().padStart(2,'0')}` and the currency symbol/code. Or use `Intl.NumberFormat` with `{style:'currency'}` passing the **bigint** of major units and formatting the fractional part separately. Add a regression test at the 2^53 boundary. At minimum, correct the docstring to state the real limit.
- **Ref:** checklist §1 (numeric correctness, `bigint` past 2^53), §25 (no float money), §5 (comments must not lie).

### P2-SHARED-02 — No field-level shared↔OpenAPI parity gate; openapi zod schemas hand-rolled and unguarded

- **Severity:** P2 (Medium) — missing control on a contract seam. A field added to a shared response type + its backend handler would NOT fail any gate if the matching openapi zod schema omitted it, so generated clients would strip the field silently.
- **Files:** `scripts/check-openapi-parity.mjs` (route/status only), `scripts/check-shared-type-parity.mjs` (web↔backend name collision only), `apps/backend/src/openapi/orders-loop-reads.ts` + siblings (hand-rolled `z.object`).
- **Evidence:** `check-openapi-parity.mjs` checks only mount↔registration existence + status codes (429/404/403), never response **field sets**. `check-shared-type-parity.mjs` only flags a type **name** declared on both web and backend; it does not compare fields, and does not look at `packages/shared` at all. The openapi response schemas are independent zod literals (`faceValueMinor: z.string()`, …) with no `z.infer`/`satisfies`/codegen tie to the shared type. The handler IS type-tied (`loop-read-handlers.ts:67` returns `: LoopOrderView`), so handler↔shared drift is caught by tsc — but openapi↔shared drift is caught only by human review. I verified current `orders-loop-reads.ts` fields DO match `LoopOrderView` (in-sync today), so this is a tooling gap, not present drift.
- **Impact:** The checklist §22/§3 parity requirement ("OpenAPI schemas match shared types match client expectations") rests entirely on reviewer diligence. The 2026-06 spec-bug class the openapi-parity gate was built to kill (drift between spec and reality) is only partially closed — status/route drift is gated, field drift is not.
- **Fix:** Derive openapi schemas from shared types where feasible (zod schema in shared, `z.infer` as the shared TS type, openapi imports the same schema — eliminates the second declaration), OR add a check that diffs each openapi response schema's top-level keys against the corresponding shared interface's keys with an allowlist. Document the residual gap in `ADR 019` / `packages/shared/AGENTS.md` either way.
- **Ref:** checklist §3 (response-shape parity), §22 (type-contract integrity), ADR 019.

### P3-SHARED-03 — `orders.ts` docstring describes non-existent Loop-native states

- **Severity:** P3 (Low) — doc lie; misleads readers about the order state machine.
- **File:** `packages/shared/src/orders.ts:13-14`
- **Evidence:** The `OrderStatus` JSDoc contrasts the legacy CTX-proxy flow against the Loop-native one and says the latter goes `created → paid → fulfilled → settled`. The actual canonical machine (`order-state.ts` `ORDER_STATES`, mirrored by `orders_state_known`) is `pending_payment → paid → procuring → fulfilled / failed / expired`. There is no `created` and no `settled` state anywhere.
- **Impact:** A reader trusting this comment would expect states the DB CHECK rejects.
- **Fix:** Update the comment to `pending_payment → paid → procuring → fulfilled (failed/expired)` referencing `order-state.ts` as the source of truth.
- **Ref:** checklist §5 (inline comments truthful), §1 (enum/state correctness).

### P3-SHARED-04 — proto generator version skew (v2.11.0 generated vs @bufbuild/protobuf 2.12.0 installed)

- **Severity:** P3 (Low) — no behavioural impact while the schema is unchanged.
- **Files:** `packages/shared/src/proto/clustering_pb.ts:1` (header `protoc-gen-es v2.11.0`), `packages/shared/package.json` (`@bufbuild/protobuf: 2.12.0`).
- **Evidence:** Generated header pins v2.11.0; the runtime dep is 2.12.0. The generated descriptor matches `apps/backend/proto/clustering.proto` exactly (field numbers/names/types verified), so there is no current drift — but the next `npm run proto:generate` will rewrite the header and could surface a codegen diff at an inopportune time.
- **Fix:** Re-run `npm run proto:generate` to re-sync the generator version (or pin the generator), so a future regen produces a clean no-op diff.
- **Ref:** checklist §22 (proto regenerated & not drifted), §10 (version alignment).

### P3-SHARED-05 — `Region.currency` narrower union than `SupportedCurrency` (note, not a defect)

- **Severity:** P3 (informational) — intentional; flagged for completeness.
- **Files:** `packages/shared/src/regions.ts:52` (`'USD'|'CAD'|'GBP'|'EUR'`) vs `countries.ts:33` (`SUPPORTED_CURRENCIES`, 9 codes incl. ADR 035 extended markets).
- **Evidence:** `regions.ts` is documented as superseded by `countries.ts` (ADR 034 phase 5) and retained only for `GeoResponse` + `regionForCountry`. Its currency union deliberately excludes the ADR 035 extended currencies because the region model never served those markets. No drift risk: the two models are not expected to converge; `regions.ts` is on a retirement path.
- **Fix:** None required. When `regions.ts` is finally deleted, ensure `GeoResponse` (still live, `/api/public/geo`) moves to `countries.ts` or its own module first.
- **Ref:** checklist §14 (dead/superseded code), ADR 034.

## Summary

- **P0: 0**
- **P1: 0**
- **P2: 2** — (1) `formatMinorCurrency` silently mis-renders aggregate money past 2^53 while its docstring claims the opposite; (2) no field-level shared↔OpenAPI parity gate — openapi zod schemas are hand-rolled and unguarded against shared-type drift.
- **P3: 3** — `orders.ts` state-machine doc lie; proto generator version skew; `regions.ts` narrower currency union (informational).

Files examined: 37 shared source files (incl. proto) + 2 parity scripts + 2
allowlists + proto `.proto` source + 5 DB CHECK constraints + sampled openapi
schema/handler files = **shared package fully covered**.

Type-contract integrity is otherwise strong: all five state/enum tuples
(`ORDER_STATES`, `ORDER_PAYMENT_METHODS`, `PAYOUT_STATES`,
`CREDIT_TRANSACTION_TYPES`, `HOME_CURRENCIES`) match their Drizzle CHECK
constraints byte-for-byte; the `HomeCurrency↔LoopAssetCode` map is total and
compile-enforced; proto is in-sync; slugs/grouping country-awareness is correct
and well-tested; both parity gates pass; the AGENTS.md Files table is accurate;
the single runtime dep matches the no-runtime-deps rule. The two P2s are a
correctness latent (implausible scale, but the docstring lies) and a tooling gap
(field-level contract parity rests on human review), neither launch-blocking.
