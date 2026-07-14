#!/usr/bin/env tsx
/**
 * Backfill: encrypt pre-existing PLAINTEXT gift-card redeem secrets
 * (NS-10; CF-25 / X-PRIV-03 follow-up).
 *
 * `orders.redeem_code` / `redeem_pin` are the spendable bearer secrets.
 * They are AES-256-GCM envelope-encrypted at rest on the write path
 * (`orders/redeem-crypto.ts`, tagged `enc:v1:<base64url>`) whenever
 * `LOOP_REDEEM_ENCRYPTION_KEY` is set, and NS-10 makes that key
 * MANDATORY in production (env.ts fails closed at boot). But rows
 * fulfilled BEFORE the key was set — or while a pre-NS-10 prod deploy
 * ran without it — hold their code/PIN as PLAINTEXT. This one-shot
 * sweep encrypts those legacy rows so a logical DB read (leaked
 * DATABASE_URL, rogue `loop_readonly` SELECT, backup exfiltration) can
 * no longer harvest spendable cards.
 *
 * Why a committed SCRIPT and not a numbered SQL migration: encrypting
 * plaintext requires the application's AES key (`LOOP_REDEEM_ENCRYPTION_KEY`,
 * an env secret that is deliberately NOT in the database) and the
 * app's crypto envelope. A numbered migration runs pure SQL with no
 * access to either. So this is a deploy-time step run with the key in
 * the environment, exactly like `check-ledger-invariant.ts` — NOT part
 * of the migration journal.
 *
 * ── The discriminator (idempotency crux) ──────────────────────────
 *
 * "Already encrypted" vs "still plaintext" is told apart by the SAME
 * `enc:v1:` version prefix the read/write paths use
 * (`isEncryptedRedeemField`). A value already carrying the prefix is
 * skipped (never re-wrapped — `encryptRedeemField` is itself
 * idempotent as a second line of defence). So the sweep is safe to
 * re-run: a second pass finds no plaintext candidates and encrypts
 * nothing. The SQL candidate filter mirrors the same predicate
 * (`NOT LIKE 'enc:v1:%'`) so already-encrypted rows are never even
 * fetched.
 *
 * ── Safety properties ─────────────────────────────────────────────
 *
 *   - Requires the key: refuses to run when `LOOP_REDEEM_ENCRYPTION_KEY`
 *     is unset. Without it `encryptRedeemField` is a plaintext
 *     passthrough, so a keyless run would silently "succeed" having
 *     encrypted nothing — fail loud instead.
 *   - Batched by a keyset cursor on `id` (strictly increasing) so the
 *     sweep terminates and never re-scans a row within a run, however
 *     large the table.
 *   - Compare-and-set write: each UPDATE re-asserts the row still holds
 *     the exact plaintext we read, so a concurrent writer (the app
 *     fulfilling a new order, which already writes ciphertext) is never
 *     clobbered. A lost race is a no-op this pass; a re-run catches it.
 *   - `--dry-run` reports what WOULD be encrypted without writing.
 *
 * Usage:
 *   LOOP_REDEEM_ENCRYPTION_KEY=... DATABASE_URL=postgres://... \
 *     npx tsx src/scripts/backfill-redeem-encryption.ts [--dry-run] [--batch-size=N]
 *
 * Exit codes:
 *   0 — completed (summary printed to stdout)
 *   2 — error (key unset / DB error; details to stderr)
 */
/* eslint-disable no-console */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, asc, gt, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { db, closeDb, type DB } from '../db/client.js';
import { orders } from '../db/schema.js';
import {
  encryptRedeemField,
  isEncryptedRedeemField,
  resolveRedeemKey,
  REDEEM_ENVELOPE_PREFIX,
} from '../orders/redeem-crypto.js';

/** Default rows fetched (and encrypted) per batch. */
export const DEFAULT_BACKFILL_BATCH_SIZE = 500;

export interface BackfillRedeemEncryptionResult {
  /** Candidate rows fetched (at least one plaintext secret field). */
  scanned: number;
  /** Rows whose code and/or PIN were newly encrypted (an UPDATE landed). */
  rowsEncrypted: number;
  /** Individual columns (code/PIN) turned from plaintext into ciphertext. */
  fieldsEncrypted: number;
  /** Rows fetched but skipped because a concurrent writer changed them. */
  raced: number;
  /** Batches executed. */
  batches: number;
  /** True when no write was performed (dry run). */
  dryRun: boolean;
}

/** SQL predicate: a non-null column that is NOT already an `enc:v1:` envelope. */
function plaintextPredicate(column: AnyPgColumn): SQL {
  // The prefix carries no LIKE wildcards, so `${prefix}%` is an exact
  // "starts-with" match, bound as a parameter (no injection surface).
  return sql`${column} IS NOT NULL AND ${column} NOT LIKE ${REDEEM_ENVELOPE_PREFIX + '%'}`;
}

/**
 * Encrypts every legacy-plaintext redeem secret in `orders`. Injectable
 * `database` so the integration test can drive the real pool; the CLI
 * passes the module `db`.
 *
 * Idempotent + re-runnable: keys off the `enc:v1:` discriminator, so a
 * second run is a no-op. Safe to interrupt: each batch commits its own
 * row updates independently, and a resumed run simply re-scans from the
 * start (already-encrypted rows are filtered out by the SQL predicate).
 */
export async function backfillRedeemEncryption(
  database: DB,
  opts?: { batchSize?: number; dryRun?: boolean },
): Promise<BackfillRedeemEncryptionResult> {
  // Refuse to run without the key — a keyless run would encrypt nothing
  // (encryptRedeemField passes plaintext through) yet report success.
  if (resolveRedeemKey() === null) {
    throw new Error(
      'backfill-redeem-encryption: LOOP_REDEEM_ENCRYPTION_KEY is unset — cannot encrypt. ' +
        'Set the 32-byte key in the environment and re-run.',
    );
  }

  const batchSize = Math.max(1, opts?.batchSize ?? DEFAULT_BACKFILL_BATCH_SIZE);
  const dryRun = opts?.dryRun ?? false;
  const result: BackfillRedeemEncryptionResult = {
    scanned: 0,
    rowsEncrypted: 0,
    fieldsEncrypted: 0,
    raced: 0,
    batches: 0,
    dryRun,
  };

  // Keyset cursor on the uuid PK. `'' `-collates below any uuid, so the
  // first `gt` fetches from the start; each batch advances the cursor to
  // its last row's id, guaranteeing forward progress + termination.
  let cursor = '00000000-0000-0000-0000-000000000000';

  for (;;) {
    const rows = await database
      .select({
        id: orders.id,
        redeemCode: orders.redeemCode,
        redeemPin: orders.redeemPin,
      })
      .from(orders)
      .where(
        and(
          gt(orders.id, cursor),
          or(plaintextPredicate(orders.redeemCode), plaintextPredicate(orders.redeemPin)),
        ),
      )
      .orderBy(asc(orders.id))
      .limit(batchSize);

    if (rows.length === 0) break;
    result.batches++;
    result.scanned += rows.length;
    cursor = rows[rows.length - 1]!.id;

    for (const row of rows) {
      // `encryptRedeemField` is idempotent: it wraps a plaintext value,
      // returns an already-`enc:v1:` value unchanged, and maps null→null.
      const newCode = encryptRedeemField(row.redeemCode);
      const newPin = encryptRedeemField(row.redeemPin);

      // Count only the columns that actually flip plaintext→ciphertext.
      const codeChanged = row.redeemCode !== null && !isEncryptedRedeemField(row.redeemCode);
      const pinChanged = row.redeemPin !== null && !isEncryptedRedeemField(row.redeemPin);
      if (!codeChanged && !pinChanged) continue; // defensive — filter already excludes these

      if (dryRun) {
        result.rowsEncrypted++;
        result.fieldsEncrypted += (codeChanged ? 1 : 0) + (pinChanged ? 1 : 0);
        continue;
      }

      // Compare-and-set: only rewrite if the row still holds the exact
      // plaintext we read. `IS NOT DISTINCT FROM` matches NULLs too, so a
      // row a concurrent writer touched between our SELECT and UPDATE is
      // left alone (its new value is already ciphertext, or a re-run
      // catches it) rather than clobbered.
      const updated = await database
        .update(orders)
        .set({ redeemCode: newCode, redeemPin: newPin })
        .where(
          and(
            sql`${orders.id} = ${row.id}`,
            sql`${orders.redeemCode} IS NOT DISTINCT FROM ${row.redeemCode}`,
            sql`${orders.redeemPin} IS NOT DISTINCT FROM ${row.redeemPin}`,
          ),
        )
        .returning({ id: orders.id });

      if (updated.length === 0) {
        result.raced++;
        continue;
      }
      result.rowsEncrypted++;
      result.fieldsEncrypted += (codeChanged ? 1 : 0) + (pinChanged ? 1 : 0);
    }
  }

  return result;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const batchArg = argv.find((a) => a.startsWith('--batch-size='));
  const batchSize = batchArg ? Number.parseInt(batchArg.split('=')[1] ?? '', 10) : undefined;
  if (batchSize !== undefined && (Number.isNaN(batchSize) || batchSize < 1)) {
    console.error('FAILED: --batch-size must be a positive integer.');
    return 2;
  }

  const r = await backfillRedeemEncryption(db, {
    dryRun,
    ...(batchSize !== undefined ? { batchSize } : {}),
  });
  console.log(
    `${r.dryRun ? 'DRY-RUN: would encrypt' : 'DONE: encrypted'} ${r.rowsEncrypted} order row(s) ` +
      `(${r.fieldsEncrypted} field(s)) across ${r.batches} batch(es); scanned ${r.scanned}, ` +
      `raced ${r.raced}.`,
  );
  if (r.raced > 0 && !r.dryRun) {
    console.log(
      `  NOTE: ${r.raced} row(s) changed under a concurrent writer and were skipped — ` +
        're-run this script (it is idempotent) to sweep them.',
    );
  }
  return 0;
}

// Only run the CLI when invoked directly (`tsx …backfill-redeem-encryption.ts`);
// importing it for the test must NOT hit the DB or exit. Mirrors
// `check-ledger-invariant.ts`.
const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main()
    .then(async (code) => {
      await closeDb();
      process.exit(code);
    })
    .catch(async (err: unknown) => {
      console.error('FAILED: redeem-encryption backfill errored.');
      console.error(err);
      await closeDb().catch(() => {});
      process.exit(2);
    });
}
