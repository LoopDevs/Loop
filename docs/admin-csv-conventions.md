---
title: Admin CSV export conventions
---

# Admin CSV export conventions

Every admin CSV exporter at `apps/backend/src/admin/*-csv.ts` follows
the same wire conventions. Consumers (finance / legal / ops tooling)
rely on them being stable — changes here need a migration note in the
PR that makes them.

Closes A2-1523. Prior to this doc the minor-unit convention was
implicit in column names; an auditor pasting a column into a
spreadsheet sum could accidentally treat pence as dollars.

## Encoding

- **Charset**: UTF-8, no BOM.
- **Line separator**: `\r\n` (RFC 4180).
- **Field separator**: `,`.
- **Quoting**: fields with `,` / `"` / newline / leading `=` `+` `-` `@`
  (formula-injection prefixes, A2-1602) are wrapped in `"` with
  internal `"` doubled.

## Numeric columns — minor units

Any column whose name ends in `_minor` carries an integer number of
the currency's minor unit (pence for GBP, cents for USD/EUR). Values
are emitted verbatim — no decimal point, no thousands separator, no
currency symbol. Examples:

| Column              | Interpretation                                                 |
| ------------------- | -------------------------------------------------------------- |
| `cashback_minor`    | cashback paid to the user, in the row's `currency` minor units |
| `face_value_minor`  | gift card face value, in the gift card's catalog currency      |
| `charge_minor`      | what the user paid, in the user's home currency (ADR 015)      |
| `wholesale_minor`   | what Loop paid CTX, in the `charge_currency`                   |
| `loop_margin_minor` | Loop's margin on the order                                     |

**To convert to the major unit**: divide by 100 (pence / cents per
currency; Loop does not currently support zero-decimal currencies
like JPY on the admin surface). Every `_minor` column is paired with
a `currency` or `charge_currency` column in the same row — group by
the currency before summing.

## Stellar-stroop columns

Any column whose name ends in `_stroops` (or carries `Stroops` in a
header) is a BigInt-as-string in Stellar's 7-decimal precision.
Divide by 10,000,000 for the human-scale asset amount.

Example: `totalStroops: "50000000000"` → 5,000 of the asset.

## Date / timestamp columns

- ISO-8601 UTC, with explicit `Z` suffix (e.g. `2026-04-20T10:00:00.000Z`).
- `day` columns (no time) emit `YYYY-MM-DD` in UTC.
- Header column names ending in `_at` are always timestamps; columns
  named `day`, `month`, `period_cursor` are calendar dates.

## Bigint safety

Large counters (supplier spend totals, lifetime-charge rollups) can
exceed `Number.MAX_SAFE_INTEGER` on high-volume merchants. These are
emitted as plain integer strings — do **not** parse with `Number()`
if you plan to sum across rows; use `BigInt()` or the spreadsheet's
currency/number-with-precision format.

## Truncation marker

Every exporter caps rows at `ROW_CAP` (10,000 by default). When the
underlying query would have returned more, a final row `__TRUNCATED__`
is appended so consumers know the dataset is incomplete and can
re-request with a narrower window.

## Adding a new exporter

1. Mirror an existing file (start from `user-credits-csv.ts` — it's
   the simplest shape).
2. Use `csvEscape` / `csvRow` from `apps/backend/src/admin/csv-escape.ts`
   (A2-1602 formula-injection-safe).
3. Use the `_minor` / `_stroops` suffix convention above for numeric
   columns. Reviewers will push back on exports that emit floats.
4. Write the Content-Disposition filename as
   `<surface>-<YYYY-MM-DD>.csv` so operators can keep a dated archive
   without a collision.
5. Register the endpoint in `apps/backend/src/openapi.ts` with the
   `text/csv` content-type. The A2-1507 drift check will flag a
   missing registration.
