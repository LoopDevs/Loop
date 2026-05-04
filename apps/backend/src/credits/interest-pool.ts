/**
 * Interest forward-mint pool address resolver (ADR 009 / 015).
 *
 * Returns the Stellar account address used as the forward-mint
 * pool for daily interest accrual. Resolution order:
 *
 *   1. `LOOP_INTEREST_POOL_ACCOUNT` env var if set — operators with
 *      a deliberate split between operator-payout custody and the
 *      interest pool use this.
 *   2. Otherwise the operator account itself (derived from
 *      `LOOP_STELLAR_OPERATOR_SECRET`). The operator already holds
 *      LOOP-asset custody and submits payouts from there, so reusing
 *      it as the interest pool is the simplest topology.
 *   3. `null` when neither is configured — the drift watcher and
 *      forecast endpoints treat this as "interest pool isn't wired
 *      up; pool balance assumed 0."
 *
 * Pure-ish: the operator pubkey derivation calls into the Stellar
 * SDK once per process (the result is cached by the resolvePayoutConfig
 * caller pattern, but this module re-derives on each call to keep
 * the helper a pure read of env). The drift watcher and forecast
 * endpoint each call this once per tick / request, so re-derivation
 * cost is acceptable.
 */
import { Keypair } from '@stellar/stellar-sdk';
import { env } from '../env.js';
import { logger } from '../logger.js';

const log = logger.child({ area: 'interest-pool' });

let cachedAccount: string | null | undefined = undefined;

/**
 * Test seam: forces re-derivation on the next call so a test can
 * flip `LOOP_INTEREST_POOL_ACCOUNT` / `LOOP_STELLAR_OPERATOR_SECRET`
 * between cases without process-restart.
 */
export function __resetInterestPoolForTests(): void {
  cachedAccount = undefined;
}

export function resolveInterestPoolAccount(): string | null {
  if (cachedAccount !== undefined) return cachedAccount;

  const explicit = env.LOOP_INTEREST_POOL_ACCOUNT;
  if (typeof explicit === 'string' && explicit.length > 0) {
    cachedAccount = explicit;
    return cachedAccount;
  }

  if (env.LOOP_STELLAR_OPERATOR_SECRET === undefined) {
    cachedAccount = null;
    return cachedAccount;
  }

  try {
    cachedAccount = Keypair.fromSecret(env.LOOP_STELLAR_OPERATOR_SECRET).publicKey();
    return cachedAccount;
  } catch (err) {
    log.error(
      { err },
      'LOOP_STELLAR_OPERATOR_SECRET present but invalid — interest pool unresolved',
    );
    cachedAccount = null;
    return cachedAccount;
  }
}
