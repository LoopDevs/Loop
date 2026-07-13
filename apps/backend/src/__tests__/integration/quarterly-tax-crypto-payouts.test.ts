/**
 * FT-04 — quarterly-tax `crypto-payouts` regulatory total on real
 * postgres.
 *
 * The `crypto-payouts` export is a regulatory figure: crypto PAID TO
 * users in the quarter. `pending_payouts` multiplexes four money-
 * movement kinds, and one of them — `kind='burn'` — is NOT a payment
 * to the user: it is the issuer-return side of a REDEMPTION
 * (`markOrderPaid` / vault-redemption forward the received LOOP to the
 * asset's issuer/operator, never to the user; see
 * `orders/transitions.ts` + `credits/vaults/vault-redemptions.ts`).
 * Summing burns into the payout total double-counts / overstates the
 * crypto-paid figure — a redemption whose genuine crypto payment is a
 * separate movement gets counted twice.
 *
 * This suite seeds a redemption (a `kind='burn'` row) alongside a
 * genuine confirmed payout for the SAME user+asset and asserts the
 * regulatory total counts ONLY the payout, not the burn. It is proven
 * RED against the pre-fix query (no `kind` filter): the burn's stroops
 * leak into the sum and a redeem-only user materialises a phantom
 * payout row.
 *
 * Gated on `LOOP_E2E_DB=1` like the sibling integration suites.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

import { db } from '../../db/client.js';
import { users, orders, pendingPayouts } from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { parseQuarter, queryCryptoPayouts } from '../../scripts/quarterly-tax.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

// Valid Stellar-shaped fixtures (56-char base32 `G…`) that satisfy the
// `pending_payouts` asset_issuer / to_address CHECK regexes. Reused
// from the payout-worker integration seed conventions.
const USDLOOP_ISSUER = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const USER_WALLET = 'GUSERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// Confirmed inside 2026-Q2 (Apr 1 → Jul 1, UTC exclusive end).
const CONFIRMED_AT = new Date('2026-05-15T12:00:00.000Z');

// Distinct amounts so a wrong exclusion (dropping the payout instead of
// the burn) also fails, not just a right-sized coincidence.
const PAYOUT_STROOPS = 300_000_000n; // genuine crypto paid to the user
const BURN_STROOPS = 250_000_000n; // redemption issuer-return — NOT paid to the user

async function seedUser(tag: string): Promise<string> {
  const user = await findOrCreateUserByEmail(
    `ft04-${tag}-${Date.now()}-${Math.random()}@test.local`,
  );
  await db.update(users).set({ homeCurrency: 'USD' }).where(eq(users.id, user.id));
  return user.id;
}

/** Seed a minimal order row so a payout/burn can satisfy its order_id FK. */
async function seedOrder(
  userId: string,
  opts: { paymentMethod: string; state: string },
): Promise<string> {
  const [row] = await db
    .insert(orders)
    .values({
      userId,
      merchantId: 'amazon',
      faceValueMinor: 2500n,
      currency: 'USD',
      chargeMinor: 2500n,
      chargeCurrency: 'USD',
      paymentMethod: opts.paymentMethod,
      paymentMemo: `ft04-memo-${Date.now()}-${Math.random()}`,
      wholesalePct: '70.00',
      userCashbackPct: '5.00',
      loopMarginPct: '25.00',
      wholesaleMinor: 1750n,
      userCashbackMinor: 125n,
      loopMarginMinor: 625n,
      state: opts.state,
    })
    .returning({ id: orders.id });
  if (row === undefined) throw new Error('seed: orders insert returned no row');
  return row.id;
}

/** Seed a confirmed pending_payout of the given kind, dated inside 2026-Q2. */
async function seedConfirmedPayout(args: {
  userId: string;
  orderId: string;
  kind: 'order_cashback' | 'burn';
  amountStroops: bigint;
}): Promise<void> {
  // A burn forwards LOOP to the issuer; a cashback payout goes to the
  // user's wallet — the exact distinction the report must respect.
  const toAddress = args.kind === 'burn' ? USDLOOP_ISSUER : USER_WALLET;
  await db.insert(pendingPayouts).values({
    userId: args.userId,
    orderId: args.orderId,
    kind: args.kind,
    assetCode: 'USDLOOP',
    assetIssuer: USDLOOP_ISSUER,
    toAddress,
    amountStroops: args.amountStroops,
    memoText: `ft04-${args.kind}-${Date.now()}-${Math.random()}`.slice(0, 28),
    state: 'confirmed',
    txHash: `ft04txhash-${Date.now()}-${Math.random()}`,
    submittedAt: CONFIRMED_AT,
    confirmedAt: CONFIRMED_AT,
  });
}

describeIf('FT-04: crypto-payouts excludes redemption burns', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  it('a redemption (burn + payout) contributes the payout once, not the burn too', async () => {
    // User U: a genuine confirmed crypto payout (order_cashback) AND a
    // redemption burn, same user + asset, same quarter. The regulatory
    // total must count ONLY the payout.
    const userU = await seedUser('u');
    const cashbackOrder = await seedOrder(userU, { paymentMethod: 'xlm', state: 'fulfilled' });
    const redeemOrder = await seedOrder(userU, { paymentMethod: 'loop_asset', state: 'paid' });
    await seedConfirmedPayout({
      userId: userU,
      orderId: cashbackOrder,
      kind: 'order_cashback',
      amountStroops: PAYOUT_STROOPS,
    });
    await seedConfirmedPayout({
      userId: userU,
      orderId: redeemOrder,
      kind: 'burn',
      amountStroops: BURN_STROOPS,
    });

    const quarter = parseQuarter('2026-Q2');
    expect(quarter).not.toBeNull();
    const rows = await queryCryptoPayouts(quarter!);

    const uRow = rows.find((r) => r.user_id === userU && r.asset_code === 'USDLOOP');
    expect(uRow).toBeDefined();
    // ONLY the payout — not payout + burn (550_000_000n). Pre-fix, the
    // burn leaks in and this reads 550_000_000n.
    expect(BigInt(String(uRow!.amount_stroops_sum))).toBe(PAYOUT_STROOPS);
    // One counted movement (the payout), not two. Pre-fix: 2.
    expect(Number(uRow!.row_count)).toBe(1);
  });

  it('a redeem-only user (burn, no payout) contributes nothing to the report', async () => {
    // User V redeemed but was never paid crypto — only a burn confirmed
    // in the quarter. The regulatory total must not materialise a
    // phantom "crypto paid" row for them. Pre-fix, the burn surfaces V
    // with BURN_STROOPS.
    const userV = await seedUser('v');
    const redeemOrder = await seedOrder(userV, { paymentMethod: 'loop_asset', state: 'paid' });
    await seedConfirmedPayout({
      userId: userV,
      orderId: redeemOrder,
      kind: 'burn',
      amountStroops: BURN_STROOPS,
    });

    const quarter = parseQuarter('2026-Q2');
    const rows = await queryCryptoPayouts(quarter!);

    const vRow = rows.find((r) => r.user_id === userV);
    expect(vRow).toBeUndefined();
  });
});
