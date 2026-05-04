#!/usr/bin/env tsx
/**
 * Quarterly tax / regulatory reports (ADR-026 Phase-1, A4-062).
 *
 * Emits the three Phase-1 CSV exports the ADR commits to:
 *
 *   - `gift-card-sales-{YYYY-Q}.csv` — per-(merchant_id, currency)
 *     fulfilled order count, gross face value, wholesale paid to CTX,
 *     user cashback emitted, Loop margin retained.
 *   - `cashback-rebates-{YYYY-Q}.csv` — per-(user_id, currency)
 *     `credit_transactions.type='cashback'` totals + row count.
 *   - `crypto-payouts-{YYYY-Q}.csv` — per-(user_id, asset_code)
 *     `pending_payouts.state='confirmed'` totals + row count.
 *
 * Each CSV's first row is a metadata comment line (`#`) carrying the
 * report id, quarter window, generation timestamp, and a note about
 * the home_currency-as-jurisdiction proxy (Phase-2 will replace it
 * with `users.tax_residence_country` per ADR-026 §Phase 2).
 *
 * Output goes to `tmp/reports/{quarter}/` relative to the repo root
 * — gitignored; the operator uploads from there to whichever
 * accountant / portal needs it. The directory is created on demand.
 *
 * Usage:
 *   DATABASE_URL=... npm run report:quarterly-tax -- --quarter=2026-Q2
 *
 * Exit codes:
 *   0 — all three CSVs written
 *   1 — argument validation failed (missing/invalid `--quarter`)
 *   2 — DB error (details on stderr)
 */
/* eslint-disable no-console */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db, closeDb } from '../db/client.js';

interface QuarterRange {
  /** Inclusive ISO datetime of the first ms of the quarter. */
  startsAt: string;
  /** Exclusive ISO datetime of the first ms of the next quarter. */
  endsBefore: string;
  /** Original `YYYY-Q` token, used for filenames + report ids. */
  label: string;
}

function parseQuarter(arg: string): QuarterRange | null {
  const match = /^(\d{4})-Q([1-4])$/.exec(arg);
  if (match === null) return null;
  const year = Number.parseInt(match[1]!, 10);
  const quarter = Number.parseInt(match[2]!, 10);
  // Q1 starts in Jan (month 0), Q2 in Apr (3), Q3 in Jul (6), Q4 in Oct (9).
  const startMonth = (quarter - 1) * 3;
  const startsAt = new Date(Date.UTC(year, startMonth, 1));
  // Next quarter's first day, in UTC. December's `Date.UTC(year, 12, 1)`
  // rolls forward to January of `year+1` automatically.
  const endsBefore = new Date(Date.UTC(year, startMonth + 3, 1));
  return {
    startsAt: startsAt.toISOString(),
    endsBefore: endsBefore.toISOString(),
    label: arg,
  };
}

function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // RFC 4180: a field that contains comma / quote / newline must be
  // quoted, with embedded quotes doubled.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(fields: readonly unknown[]): string {
  return fields.map(csvField).join(',') + '\n';
}

interface ReportContext {
  quarter: QuarterRange;
  generatedAt: string;
  outDir: string;
}

function metadataHeader(ctx: ReportContext, reportId: string): string {
  // CSV-comment first line. Most spreadsheet importers ignore lines
  // starting with `#` if asked; accountants reading the file in a
  // text editor get the context inline either way.
  return [
    `# report=${reportId}`,
    `# quarter=${ctx.quarter.label}`,
    `# window=${ctx.quarter.startsAt}/${ctx.quarter.endsBefore}`,
    `# generated_at=${ctx.generatedAt}`,
    `# proxy_note=user.home_currency is the jurisdiction proxy until ADR-026 Phase-2 lands explicit users.tax_residence_country.`,
    '',
  ].join('\n');
}

async function emitGiftCardSales(ctx: ReportContext): Promise<string> {
  const reportId = 'gift-card-sales';
  const rows = (await db.execute(sql`
    SELECT
      merchant_id,
      currency,
      COUNT(*)::bigint AS order_count,
      COALESCE(SUM(face_value_minor), 0)::bigint AS face_value_minor_sum,
      COALESCE(SUM(wholesale_minor), 0)::bigint AS wholesale_minor_sum,
      COALESCE(SUM(user_cashback_minor), 0)::bigint AS user_cashback_minor_sum,
      COALESCE(SUM(loop_margin_minor), 0)::bigint AS loop_margin_minor_sum
    FROM orders
    WHERE state = 'fulfilled'
      AND fulfilled_at >= ${ctx.quarter.startsAt}::timestamptz
      AND fulfilled_at < ${ctx.quarter.endsBefore}::timestamptz
    GROUP BY merchant_id, currency
    ORDER BY merchant_id, currency
  `)) as unknown as Array<{
    merchant_id: string;
    currency: string;
    order_count: string | bigint;
    face_value_minor_sum: string | bigint;
    wholesale_minor_sum: string | bigint;
    user_cashback_minor_sum: string | bigint;
    loop_margin_minor_sum: string | bigint;
  }>;
  let out = metadataHeader(ctx, reportId);
  out += csvRow([
    'merchant_id',
    'currency',
    'order_count',
    'face_value_minor_sum',
    'wholesale_minor_sum',
    'user_cashback_minor_sum',
    'loop_margin_minor_sum',
  ]);
  for (const r of rows) {
    out += csvRow([
      r.merchant_id,
      r.currency,
      r.order_count,
      r.face_value_minor_sum,
      r.wholesale_minor_sum,
      r.user_cashback_minor_sum,
      r.loop_margin_minor_sum,
    ]);
  }
  const outPath = resolve(ctx.outDir, `${reportId}-${ctx.quarter.label}.csv`);
  writeFileSync(outPath, out, 'utf8');
  return outPath;
}

async function emitCashbackRebates(ctx: ReportContext): Promise<string> {
  const reportId = 'cashback-rebates';
  const rows = (await db.execute(sql`
    SELECT
      user_id,
      currency,
      COUNT(*)::bigint AS row_count,
      COALESCE(SUM(amount_minor), 0)::bigint AS amount_minor_sum
    FROM credit_transactions
    WHERE type = 'cashback'
      AND created_at >= ${ctx.quarter.startsAt}::timestamptz
      AND created_at < ${ctx.quarter.endsBefore}::timestamptz
    GROUP BY user_id, currency
    ORDER BY user_id, currency
  `)) as unknown as Array<{
    user_id: string;
    currency: string;
    row_count: string | bigint;
    amount_minor_sum: string | bigint;
  }>;
  let out = metadataHeader(ctx, reportId);
  out += csvRow(['user_id', 'currency', 'row_count', 'amount_minor_sum']);
  for (const r of rows) {
    out += csvRow([r.user_id, r.currency, r.row_count, r.amount_minor_sum]);
  }
  const outPath = resolve(ctx.outDir, `${reportId}-${ctx.quarter.label}.csv`);
  writeFileSync(outPath, out, 'utf8');
  return outPath;
}

async function emitCryptoPayouts(ctx: ReportContext): Promise<string> {
  const reportId = 'crypto-payouts';
  const rows = (await db.execute(sql`
    SELECT
      user_id,
      asset_code,
      COUNT(*)::bigint AS row_count,
      COALESCE(SUM(amount_stroops), 0)::bigint AS amount_stroops_sum
    FROM pending_payouts
    WHERE state = 'confirmed'
      AND confirmed_at IS NOT NULL
      AND confirmed_at >= ${ctx.quarter.startsAt}::timestamptz
      AND confirmed_at < ${ctx.quarter.endsBefore}::timestamptz
    GROUP BY user_id, asset_code
    ORDER BY user_id, asset_code
  `)) as unknown as Array<{
    user_id: string;
    asset_code: string;
    row_count: string | bigint;
    amount_stroops_sum: string | bigint;
  }>;
  let out = metadataHeader(ctx, reportId);
  out += csvRow(['user_id', 'asset_code', 'row_count', 'amount_stroops_sum']);
  for (const r of rows) {
    out += csvRow([r.user_id, r.asset_code, r.row_count, r.amount_stroops_sum]);
  }
  const outPath = resolve(ctx.outDir, `${reportId}-${ctx.quarter.label}.csv`);
  writeFileSync(outPath, out, 'utf8');
  return outPath;
}

async function main(): Promise<number> {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m !== null) args.set(m[1]!, m[2]!);
  }
  const quarterArg = args.get('quarter');
  if (quarterArg === undefined) {
    console.error(
      'usage: npm --workspace=@loop/backend run report:quarterly-tax -- --quarter=YYYY-Q',
    );
    return 1;
  }
  const quarter = parseQuarter(quarterArg);
  if (quarter === null) {
    console.error(`invalid --quarter=${quarterArg}; expected YYYY-Q (e.g. 2026-Q2)`);
    return 1;
  }

  // Output goes to tmp/reports/{quarter}/ at the repo root. The script
  // lives at apps/backend/src/scripts/quarterly-tax.ts; walk up four
  // levels to reach the repo root regardless of where the script is
  // invoked from.
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..', '..', '..');
  const outDir = resolve(repoRoot, 'tmp', 'reports', quarter.label);
  mkdirSync(outDir, { recursive: true });

  const ctx: ReportContext = {
    quarter,
    generatedAt: new Date().toISOString(),
    outDir,
  };

  console.log(
    `quarterly-tax: ${quarter.label} (${quarter.startsAt} → ${quarter.endsBefore})\n  outDir=${outDir}`,
  );
  const giftSalesPath = await emitGiftCardSales(ctx);
  console.log(`  wrote ${giftSalesPath}`);
  const cashbackPath = await emitCashbackRebates(ctx);
  console.log(`  wrote ${cashbackPath}`);
  const payoutsPath = await emitCryptoPayouts(ctx);
  console.log(`  wrote ${payoutsPath}`);
  console.log('quarterly-tax: done.');
  return 0;
}

const code = await main()
  .catch((err: unknown) => {
    console.error('quarterly-tax: failed', err);
    return 2;
  })
  .finally(() => {
    void closeDb();
  });
process.exit(code);
