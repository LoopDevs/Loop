/**
 * NS-10 — redeem-encryption backfill (real postgres).
 *
 * Proves `scripts/backfill-redeem-encryption.ts` encrypts pre-existing
 * PLAINTEXT gift-card redeem secrets at rest, is round-trip-correct, is
 * idempotent (a re-run leaves already-encrypted rows byte-identical —
 * no double-wrap), and tolerates the transition (legacy plaintext rows
 * become ciphertext that decrypts back to the original; already-
 * encrypted + null rows are untouched).
 *
 * Drives the REAL backfill against real postgres: seeds `orders` rows
 * with literal PLAINTEXT in `redeem_code` / `redeem_pin` (as a pre-NS-10
 * fulfillment would have written them), runs the sweep, and reads the
 * raw columns back to assert they are now `enc:v1:` envelopes.
 *
 * `LOOP_E2E_DB=1` gate, same per-test truncate as the sibling suites.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { orders } from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { env } from '../../env.js';
import {
  decryptRedeemField,
  isEncryptedRedeemField,
  encryptRedeemField,
  resetRedeemKeyCache,
} from '../../orders/redeem-crypto.js';
import { backfillRedeemEncryption } from '../../scripts/backfill-redeem-encryption.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';
const describeIf = RUN_INTEGRATION ? describe : describe.skip;

// A 32-byte key. Mutating the shared `env` object + resetting the memo
// cache is robust against module-import ordering (env.ts reads
// process.env only once at first import, which may already have
// happened in this worker before our file loads).
const REDEEM_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

/** Inserts a fulfilled order with the given raw redeem columns (verbatim). */
async function seedOrder(args: {
  userId: string;
  redeemCode: string | null;
  redeemPin: string | null;
}): Promise<string> {
  const [row] = await db
    .insert(orders)
    .values({
      userId: args.userId,
      merchantId: 'amazon',
      faceValueMinor: 2500n,
      currency: 'USD',
      chargeMinor: 2500n,
      chargeCurrency: 'USD',
      paymentMethod: 'credit', // skips the payment_memo coherence CHECK
      wholesalePct: '70.00',
      userCashbackPct: '5.00',
      loopMarginPct: '25.00',
      wholesaleMinor: 1750n,
      userCashbackMinor: 125n,
      loopMarginMinor: 625n,
      state: 'fulfilled',
      redeemCode: args.redeemCode,
      redeemPin: args.redeemPin,
      paidAt: new Date(),
    })
    .returning({ id: orders.id });
  if (row === undefined) throw new Error('seed: orders insert returned no row');
  return row.id;
}

async function readRaw(
  id: string,
): Promise<{ redeemCode: string | null; redeemPin: string | null }> {
  const [row] = await db
    .select({ redeemCode: orders.redeemCode, redeemPin: orders.redeemPin })
    .from(orders)
    .where(eq(orders.id, id));
  if (row === undefined) throw new Error(`readRaw: no order ${id}`);
  return row;
}

describeIf('NS-10 redeem-encryption backfill (real postgres)', () => {
  let originalKey: string | undefined;

  beforeAll(async () => {
    await ensureMigrated();
    originalKey = env.LOOP_REDEEM_ENCRYPTION_KEY;
    env.LOOP_REDEEM_ENCRYPTION_KEY = REDEEM_KEY;
    resetRedeemKeyCache();
  });

  afterAll(() => {
    env.LOOP_REDEEM_ENCRYPTION_KEY = originalKey;
    resetRedeemKeyCache();
  });

  beforeEach(async () => {
    await truncateAllTables();
    env.LOOP_REDEEM_ENCRYPTION_KEY = REDEEM_KEY;
    resetRedeemKeyCache();
  });

  it('encrypts a legacy plaintext row and round-trips it, leaving null/encrypted rows untouched', async () => {
    const user = await findOrCreateUserByEmail('ns10-backfill@test.local');

    // (1) A legacy plaintext row (both fields).
    const plaintextId = await seedOrder({
      userId: user.id,
      redeemCode: 'PLAINTEXT-GIFT-CODE-9999',
      redeemPin: '4242',
    });
    // (2) A row already encrypted before the sweep — must not change.
    const preEncCode = encryptRedeemField('ALREADY-ENC-CODE')!;
    const preEncPin = encryptRedeemField('7777')!;
    const encId = await seedOrder({
      userId: user.id,
      redeemCode: preEncCode,
      redeemPin: preEncPin,
    });
    // (3) A row with no redemption payload — must not change.
    const nullId = await seedOrder({ userId: user.id, redeemCode: null, redeemPin: null });
    // (4) A mixed row: plaintext code, null pin.
    const mixedId = await seedOrder({
      userId: user.id,
      redeemCode: 'MIXED-PLAINTEXT-CODE',
      redeemPin: null,
    });

    const result = await backfillRedeemEncryption(db, { batchSize: 2 });

    // Two rows carried plaintext (the plaintext row + the mixed row);
    // three plaintext fields total (code+pin, then code only).
    expect(result.rowsEncrypted).toBe(2);
    expect(result.fieldsEncrypted).toBe(3);
    expect(result.raced).toBe(0);

    // (1) now ciphertext on disk, and decrypts back to the originals.
    const p = await readRaw(plaintextId);
    expect(isEncryptedRedeemField(p.redeemCode!)).toBe(true);
    expect(p.redeemCode).not.toContain('PLAINTEXT-GIFT-CODE-9999');
    expect(isEncryptedRedeemField(p.redeemPin!)).toBe(true);
    expect(p.redeemPin).not.toContain('4242');
    expect(decryptRedeemField(p.redeemCode)).toBe('PLAINTEXT-GIFT-CODE-9999');
    expect(decryptRedeemField(p.redeemPin)).toBe('4242');

    // (2) already-encrypted row is byte-identical (no re-wrap).
    const e = await readRaw(encId);
    expect(e.redeemCode).toBe(preEncCode);
    expect(e.redeemPin).toBe(preEncPin);

    // (3) null row untouched.
    const n = await readRaw(nullId);
    expect(n.redeemCode).toBeNull();
    expect(n.redeemPin).toBeNull();

    // (4) mixed row: code encrypted, pin still null.
    const m = await readRaw(mixedId);
    expect(isEncryptedRedeemField(m.redeemCode!)).toBe(true);
    expect(decryptRedeemField(m.redeemCode)).toBe('MIXED-PLAINTEXT-CODE');
    expect(m.redeemPin).toBeNull();
  });

  it('is idempotent — a second run encrypts nothing and leaves ciphertext byte-identical', async () => {
    const user = await findOrCreateUserByEmail('ns10-idem@test.local');
    const id = await seedOrder({
      userId: user.id,
      redeemCode: 'IDEMPOTENT-CODE',
      redeemPin: '0001',
    });

    const first = await backfillRedeemEncryption(db, { batchSize: 500 });
    expect(first.rowsEncrypted).toBe(1);
    const afterFirst = await readRaw(id);
    expect(isEncryptedRedeemField(afterFirst.redeemCode!)).toBe(true);

    const second = await backfillRedeemEncryption(db, { batchSize: 500 });
    // Nothing left to do — the `enc:v1:` discriminator excludes the row.
    expect(second.rowsEncrypted).toBe(0);
    expect(second.fieldsEncrypted).toBe(0);
    expect(second.scanned).toBe(0);

    // Ciphertext is byte-identical after the re-run (no double-wrap) and
    // still decrypts to the original.
    const afterSecond = await readRaw(id);
    expect(afterSecond.redeemCode).toBe(afterFirst.redeemCode);
    expect(afterSecond.redeemPin).toBe(afterFirst.redeemPin);
    expect(decryptRedeemField(afterSecond.redeemCode)).toBe('IDEMPOTENT-CODE');
    expect(decryptRedeemField(afterSecond.redeemPin)).toBe('0001');
  });

  it('--dry-run counts candidates without writing', async () => {
    const user = await findOrCreateUserByEmail('ns10-dry@test.local');
    const id = await seedOrder({ userId: user.id, redeemCode: 'DRY-CODE', redeemPin: null });

    const dry = await backfillRedeemEncryption(db, { dryRun: true });
    expect(dry.rowsEncrypted).toBe(1);
    expect(dry.dryRun).toBe(true);

    // The DB is untouched — the value is still plaintext.
    const raw = await readRaw(id);
    expect(raw.redeemCode).toBe('DRY-CODE');
    expect(isEncryptedRedeemField(raw.redeemCode!)).toBe(false);
  });

  it('refuses to run when the encryption key is unset (would encrypt nothing)', async () => {
    env.LOOP_REDEEM_ENCRYPTION_KEY = undefined;
    resetRedeemKeyCache();
    await expect(backfillRedeemEncryption(db)).rejects.toThrow(
      /LOOP_REDEEM_ENCRYPTION_KEY is unset/,
    );
    // Restore for any later test in this file.
    env.LOOP_REDEEM_ENCRYPTION_KEY = REDEEM_KEY;
    resetRedeemKeyCache();
  });
});
