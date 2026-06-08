# ADR 032 — Merchant variant grouping

**Status:** Accepted (Phase-1, client-side derivation; CTX field deferred)
**Date:** 2026-06-08

## Context

CTX models **one merchant per supplier SKU**. A single brand therefore fragments
into many merchant listings:

- `dots.eco` → 14 impact SKUs (`- Plant a Tree`, `- Buy Land`, `- Fighting Wildfires`, …)
- `Town & City Gift Cards` → 69 town listings
- `Carma` → 4 tiers; `Alo Moves` / `DoorDash DashPass` / `Candy Crush` → duration/amount variants
- `GCodes`, `YouChoose`, `Inspire`, `Visa Prepaid`, … → category/SKU variants

On the real catalogue this is **30 brand families spread across 182 listings**, which
clutters the merchant list (1,134 tiles → 982 when grouped) and buries the brand under
its SKUs.

There are two flavours of variant, both handled identically by grouping:

1. **amount / duration** (Alo Moves 1/3/6-mo) — effectively denominations.
2. **distinct SKU / location** (dots.eco impacts, Town & City towns) — true variants.

## Decision

Adopt a **brand group** concept: the merchant is the brand; its SKUs are variants
nested under it. Concretely, every merchant resolves to a `group` (brand) plus a
`variantLabel`.

For **Phase 1 this is derived client-side** from the `"Brand - Variant"` naming
convention, in `@loop/shared` (`merchant-groups.ts`: `splitMerchantName`,
`groupMerchants`, `variantLabel`). Grouping is case-insensitive (so `dots.eco` and
`Dots.eco` merge) and a single-member group renders normally.

The function name and shape (`group`) are chosen so the derivation can later be
**replaced by a server-provided `group` field on the CTX merchant** without changing
callers — the grouping knowledge then lives in the catalogue (its correct home, shared
with other CTX consumers such as DCG).

## Alternatives considered

- **A — pure client-side, no shared abstraction.** Group inline in the web list by
  name prefix. Rejected: logic siloed, not reusable, no migration path to the server.
- **C — parent `Brand` → child `Variant` entities in CTX.** The "proper" model, but a
  schema migration + API surface + client rework. Deferred: not needed until the variant
  UX requires hierarchy (per-variant cart/checkout). B does not block evolving to C.

## Consequences

- **+** Big merchant-list declutter; brand-first browsing; zero CTX/backend change now.
- **+** Reversible and incremental — swapping to a CTX `group` field later is a drop-in.
- **−** Name-convention grouping can mis-group a brand legitimately named `"X - Y"`
  (rare). A small override list can be added if a false positive appears.
- **−** Grouping is recomputed client-side from names until the CTX field lands.

## Follow-ups

- Wire the web merchant list to render one tile per `MerchantGroup`, expanding to its
  variants.
- When ready, add a `group` field to the CTX merchant + `@loop/shared` `Merchant` type
  and have `groupMerchants` prefer it over the name-derived key.
