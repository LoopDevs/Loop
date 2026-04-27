/**
 * Procurement asset-picker (ADR 015 flow 3) — chooses USDC or XLM
 * for the upstream CTX charge based on the operator account\'s
 * live USDC balance vs. the configured floor.
 *
 * Lifted out of `apps/backend/src/orders/procurement.ts`. Five
 * tightly-coupled functions + state share the same concern: USDC
 * is the default rail, XLM is the break-glass when USDC is
 * insufficient, and a Discord alert fires once per cooldown
 * window when the picker has to fall back.
 *
 * Pulled into its own module so:
 *
 *   - the picker (`pickProcurementAsset`) stays unit-testable as
 *     a pure function (no I/O), driving the test-suite\'s asset-
 *     selection cases.
 *   - the throttle state (`lastBelowFloorAlertAt`) lives next to
 *     the function that reads/writes it instead of leaking into
 *     the larger procurement-tick file.
 *   - the Horizon-balance read (`readUsdcBalanceSafely`) and the
 *     alert helper (`shouldAlertBelowFloor`) co-locate with the
 *     picker that consumes them.
 */
import { logger } from '../logger.js';
import { env } from '../env.js';
import { getAccountBalances } from '../payments/horizon-balances.js';

const log = logger.child({ area: 'procurement' });

/**
 * Throttles the Discord below-floor alert so a sustained outage
 * doesn't spam the monitoring channel every tick. 15-minute window
 * matches typical ops response time — ops acts on the first alert;
 * the next alert after 15 min is a "still bad, check on this".
 */
const BELOW_FLOOR_ALERT_INTERVAL_MS = 15 * 60 * 1000;
let lastBelowFloorAlertAt = 0;
export function shouldAlertBelowFloor(nowMs: number): boolean {
  if (nowMs - lastBelowFloorAlertAt < BELOW_FLOOR_ALERT_INTERVAL_MS) return false;
  lastBelowFloorAlertAt = nowMs;
  return true;
}

/** Test seam — resets the below-floor alert throttle. */
export function __resetBelowFloorAlertForTests(): void {
  lastBelowFloorAlertAt = 0;
}

/**
 * Horizon USDC balance read, wrapped so a transient failure doesn't
 * stall procurement. A null return is the signal to the picker that
 * "we don't know the balance — default to USDC".
 */
export async function readUsdcBalanceSafely(account: string): Promise<bigint | null> {
  try {
    const snap = await getAccountBalances(account, env.LOOP_STELLAR_USDC_ISSUER ?? null);
    return snap.usdcStroops;
  } catch (err) {
    log.warn(
      { err, account },
      'Horizon USDC balance read failed — procurement proceeding with USDC',
    );
    return null;
  }
}

/**
 * Selects the crypto currency to pay CTX in (ADR 015 flow 3).
 *
 * Defaults to USDC — Loop wants to hold USDC for defindex yield,
 * but we can't pay CTX in USDC if the operator account's USDC
 * balance has dropped below the operator-configured floor. In
 * that case we burn XLM instead so procurement isn't blocked on
 * an ops top-up.
 *
 * Pure: no I/O. The caller provides the balance (from a future
 * Horizon read) and the floor (from env); this decides which
 * asset to request. Keeping this testable in isolation means the
 * policy is easy to adjust without re-exercising the whole tick.
 *
 * `balanceStroops === null` means we haven't read a balance yet
 * (Horizon integration is deferred) — default to USDC so the MVP
 * procurement path is unchanged. `floorStroops === null` means
 * the operator hasn't set a floor — fallback is disabled.
 */
export function pickProcurementAsset(args: {
  balanceStroops: bigint | null;
  floorStroops: bigint | null;
}): 'USDC' | 'XLM' {
  if (args.floorStroops === null || args.balanceStroops === null) {
    return 'USDC';
  }
  return args.balanceStroops < args.floorStroops ? 'XLM' : 'USDC';
}
