/**
 * CF2-06 (2026-06-30 cold audit): shared sanity-bound check for price
 * feeds (XLM oracle in `price-feed.ts`, fiat FX in `price-feed-fx.ts`).
 * Neither feed had any validation beyond `rate > 0` — a feed glitch or
 * compromise on either unauthenticated upstream could let a payment
 * clear at an arbitrarily wrong rate (a direct fund-loss vector: accept
 * a fraction of a gift card's real value, or systematically overcharge).
 *
 * This is a RELATIVE bound (vs the last successfully-validated rate for
 * the same currency) rather than a fixed absolute range that would need
 * constant maintenance as a rate naturally drifts over months. Each
 * feed picks its own ratio: XLM is a genuinely volatile asset (wider
 * bound), fiat FX pairs are not (tighter bound) — see each feed's own
 * constant for the reasoning specific to it.
 *
 * MNY-22 (2026-07 remediation): the pure relative bound above had two
 * holes on a money path:
 *
 *   (A) Permanent wedge / liveness bug. The reference rate is the last
 *       SUCCESSFULLY-validated cached value; a rejected refresh never
 *       updates the cache, so the anchor never advances. After a single
 *       LEGITIMATE move larger than `maxRatio` (a real market gap), every
 *       subsequent refresh compares the genuinely-correct new rate
 *       against the stale pre-move anchor and rejects it — forever.
 *       Settlement wedges even though the new rate is correct and stable.
 *       Fixed here with a corroboration streak PLUS a bounded ratchet: an
 *       out-of-bound observation is still rejected, but once
 *       `REQUIRED_CORROBORATIONS` CONSECUTIVE observations agree on the
 *       same new level, the anchor ADVANCES BY AT MOST ONE `maxRatio`
 *       STEP toward that level — never in one leap to the observed value.
 *       A single transient outlier (one bad response followed by a return
 *       to normal) resets the streak and never moves the anchor. A genuine
 *       large gap recovers over MULTIPLE corroborated cycles, each
 *       ratcheting one capped step and each paging, until the anchor is
 *       within `maxRatio` of the real rate and normal acceptance resumes.
 *
 *       Round-2 hardening (MNY-22-wedge). The round-1 fix advanced the
 *       anchor DIRECTLY to the corroborated observation, which is
 *       UNBOUNDED relative to the anchor: a sustained-compromise / spoofed
 *       feed serving an arbitrary target T three times in a row walked the
 *       settlement anchor from A straight to T (e.g. 100 → 100,000, a
 *       1000× jump) in a single 3-observation cycle — a direct fund-loss
 *       vector. Capping each accepted advance at one `maxRatio` step
 *       removes the single-cycle arbitrary jump: a walk to an arbitrary
 *       rate now costs MANY corroborated cycles and pages loudly at every
 *       step (slow + loud), while a real move still converges (see
 *       `ratchetedAnchor`).
 *
 *   (B) Cold-cache blind spot. The relative bound cannot fire on a cold
 *       cache (no prior value to compare), so the first-ever rate was
 *       accepted at ANY magnitude and ANY age. Two absolute backstops are
 *       added, both applied even on a cold cache and independent of the
 *       relative bound: an optional `staleness` bound (reject an
 *       observation whose upstream timestamp is too old) and an optional
 *       absolute `floor` (reject a rate below a per-asset minimum). Both
 *       are opt-in per call so a feed that exposes no timestamp / has no
 *       policy floor keeps today's behaviour (fail open).
 */
import { logger } from '../logger.js';
import { notifyPriceFeedAnomaly } from '../discord.js';

const log = logger.child({ area: 'rate-sanity' });

/**
 * MNY-22 (recovery-from-wedge): number of CONSECUTIVE corroborating
 * out-of-bound observations required before the anchor advances to a
 * genuinely-new rate level. The first `N-1` out-of-bound observations
 * are still rejected (and paged); the `N`th accepts and advances.
 *
 * 3 is the conservative default: a real market gap settles at a new
 * level and every subsequent upstream fetch reports it, so 3 consecutive
 * agreeing observations clear the gap quickly, while a single transient
 * glitch (or a lone injected outlier) never survives to the 3rd because
 * the very next in-bound observation resets the streak. Each rejected
 * observation still pages Discord, so an operator sees the move unfold
 * before auto-recovery completes. Corroboration counts distinct refresh
 * cycles, not repeated reads of one cached value (a fresh cache
 * short-circuits before re-validating), so it cannot be inflated by
 * hammering the feed.
 */
export const REQUIRED_CORROBORATIONS = 3;

/**
 * Per-(feed, currency) hysteresis for the recovery-from-wedge logic. A
 * streak is opened by the first out-of-bound observation and extended
 * only by subsequent observations that agree with its `candidate`
 * (within the same `maxRatio`). Any in-bound observation clears it.
 */
interface BreachStreak {
  /** The first out-of-bound observation of the current streak. */
  candidate: number;
  /** Consecutive corroborating observations so far (>= 1). */
  observations: number;
}
const breachStreaks = new Map<string, BreachStreak>();

function streakKey(feed: 'xlm' | 'fx', currency: string): string {
  return `${feed}:${currency}`;
}

/**
 * Test seam — forgets the corroboration hysteresis so each test starts
 * from a clean anchor state. Mirrors the `__reset*ForTests` idiom the
 * feed caches use. `__resetPriceFeedForTests` chains into this.
 */
export function __resetRateSanityForTests(): void {
  breachStreaks.clear();
}

/**
 * Returns true (rate accepted) unless a previous good rate exists AND
 * the new one deviates by more than `maxRatio` in either direction. No
 * previous rate (cold start) always accepts — there's nothing to
 * compare against yet.
 */
export function isPlausibleRateJump(
  previousValue: number | undefined,
  newValue: number,
  maxRatio: number,
): boolean {
  if (previousValue === undefined) return true;
  const ratio = newValue / previousValue;
  return ratio >= 1 - maxRatio && ratio <= 1 + maxRatio;
}

/**
 * MNY-22-wedge (round 2): the bounded RATCHET applied when a corroboration
 * streak reaches `REQUIRED_CORROBORATIONS`. Advances the anchor by AT MOST
 * ONE `maxRatio` step from `previousValue` TOWARD `newValue`, never
 * directly to `newValue` (which is unbounded relative to the anchor).
 * Returns a value that is guaranteed to be within `maxRatio` of
 * `previousValue`:
 *
 *   - upward   (newValue > previousValue): min(newValue, previousValue × (1 + maxRatio))
 *   - downward (newValue < previousValue): max(newValue, previousValue × (1 − maxRatio))
 *
 * So a single corroborated advance can never move the settlement anchor by
 * more than one `maxRatio` step. A genuine large gap converges over
 * several such advances (each within `maxRatio`, each paged); once the
 * anchor is within `maxRatio` of the real rate the very next observation
 * is accepted directly (normal acceptance), so recovery lands exactly on
 * the real rate — it neither oscillates nor re-wedges just short of it.
 *
 * Returned in the SAME unit as its inputs, exact and UNROUNDED: an
 * integer-unit caller (the XLM feed's micro-cents) rounds the result
 * before caching so the downstream `BigInt()` size-check math stays
 * integral; a float-unit caller (fiat FX) would consume it as-is.
 */
export function ratchetedAnchor(previousValue: number, newValue: number, maxRatio: number): number {
  if (newValue > previousValue) {
    return Math.min(newValue, previousValue * (1 + maxRatio));
  }
  return Math.max(newValue, previousValue * (1 - maxRatio));
}

/**
 * MNY-22 (B): staleness inputs. A feed that stamps each observation with
 * the upstream's own retrieval time (e.g. CTX rates' `retrieved` field)
 * passes this so an egregiously frozen feed is rejected even on a cold
 * cache. A feed with no timestamp (CoinGecko-shape / Frankfurter) omits
 * it and keeps today's behaviour.
 */
export interface RateStaleness {
  /** Upstream's retrieval time for this observation, ms epoch. */
  observedAtMs: number;
  /** Reject when `nowMs - observedAtMs` exceeds this. */
  maxAgeMs: number;
  /** Injectable clock; defaults to `Date.now()`. */
  nowMs?: number;
}

/**
 * Validates a freshly-fetched rate against the last known-good value
 * for the same currency before it's accepted into a feed's cache.
 * Rejects (throws) an implausible jump instead of silently accepting
 * it — same "feed problem → throw → caller's tick-level catch defers"
 * posture each feed already uses for missing/non-positive rates, plus
 * a Discord page since a big swing (or an attack) needs operator eyes,
 * unlike a routine transient fetch failure.
 *
 * MNY-22 checks, in order (absolute backstops first so they apply even
 * on a cold cache, then the relative bound + recovery streak):
 *   1. `floor` (optional): reject a rate below the per-asset absolute
 *      minimum. NEVER corroborated away — an absurdly low rate is
 *      rejected however stable. Fail open when undefined.
 *   2. `staleness` (optional): reject an observation older than
 *      `maxAgeMs`. Fail open when undefined.
 *   3. Relative bound vs the last good value. In bound → accept and
 *      clear any breach streak. Out of bound → corroboration streak:
 *      reject until `REQUIRED_CORROBORATIONS` consecutive agreeing
 *      observations, then RATCHET the anchor one capped `maxRatio` step
 *      toward the corroborated level and accept THAT capped value.
 *
 * Returns the value the caller must cache as the new last-known-good: the
 * observation itself on a normal (in-bound / cold-start) accept, or the
 * CAPPED intermediate on a corroborated ratchet advance — so a corroborated
 * move can never shift the settlement anchor by more than one `maxRatio`
 * step per cycle. Throws (does NOT return) on a rejected observation
 * (below floor / stale / un-corroborated jump).
 */
export function validateRateJump(args: {
  currency: string;
  feed: 'xlm' | 'fx';
  previousValue: number | undefined;
  newValue: number;
  maxRatio: number;
  /**
   * MNY-22 (B): absolute per-asset minimum acceptable rate, in the
   * feed's own cached unit. Undefined → no floor (fail open to today's
   * behaviour). The VALUE is money policy set by the feed's caller.
   */
  floor?: number | undefined;
  /** MNY-22 (B): optional upstream-staleness bound. */
  staleness?: RateStaleness | undefined;
}): number {
  // 1. Absolute floor — applies on a cold cache too, and can never be
  //    corroborated away (unlike a relative jump, an absurdly-low rate
  //    is wrong at any level of stability).
  if (args.floor !== undefined && args.newValue < args.floor) {
    log.error(
      { currency: args.currency, feed: args.feed, newValue: args.newValue, floor: args.floor },
      'MNY-22: price feed rate below absolute floor — rejecting',
    );
    throw new Error(
      `Price feed rate for ${args.currency} below absolute floor (${args.newValue} < ${args.floor})`,
    );
  }

  // 2. Staleness — applies on a cold cache too. A frozen upstream serving
  //    an ancient price is not trustworthy even with no prior value.
  if (args.staleness !== undefined) {
    const now = args.staleness.nowMs ?? Date.now();
    const ageMs = now - args.staleness.observedAtMs;
    if (ageMs > args.staleness.maxAgeMs) {
      log.error(
        {
          currency: args.currency,
          feed: args.feed,
          observedAtMs: args.staleness.observedAtMs,
          ageMs,
          maxAgeMs: args.staleness.maxAgeMs,
        },
        'MNY-22: price feed observation older than the staleness bound — rejecting',
      );
      throw new Error(
        `Price feed rate for ${args.currency} is stale (observed ${ageMs}ms ago, max ${args.staleness.maxAgeMs}ms)`,
      );
    }
  }

  // 3. Relative bound vs the last good value.
  const key = streakKey(args.feed, args.currency);
  if (isPlausibleRateJump(args.previousValue, args.newValue, args.maxRatio)) {
    // Back within bound — any in-flight breach was transient. Reset the
    // streak so an isolated outlier can never accumulate corroborations.
    // Accept the observation verbatim (this also lands recovery exactly on
    // the real rate once the ratchet has closed to within one step).
    breachStreaks.delete(key);
    return args.newValue;
  }

  // Out of bound. MNY-22 (A) recovery: track a corroboration streak so a
  // genuine, sustained move eventually advances the anchor instead of
  // wedging forever, while a lone outlier never does.
  const prior = breachStreaks.get(key);
  const next: BreachStreak =
    prior !== undefined && isPlausibleRateJump(prior.candidate, args.newValue, args.maxRatio)
      ? { candidate: prior.candidate, observations: prior.observations + 1 }
      : { candidate: args.newValue, observations: 1 };

  if (next.observations >= REQUIRED_CORROBORATIONS) {
    // The new level has persisted across N consecutive observations — it's
    // a genuine move, not a glitch. MNY-22-wedge (round 2): advance the
    // anchor by AT MOST ONE `maxRatio` step TOWARD the corroborated level,
    // never in one leap to the (unbounded) observed value. `previousValue`
    // is necessarily defined here — a cold cache always takes the in-bound
    // branch above, so an out-of-bound streak can only exist once a prior
    // anchor was cached; the `?? args.newValue` is a belt-and-braces guard.
    breachStreaks.delete(key);
    const anchor = args.previousValue ?? args.newValue;
    const advanced = ratchetedAnchor(anchor, args.newValue, args.maxRatio);
    log.warn(
      {
        currency: args.currency,
        feed: args.feed,
        previousValue: args.previousValue,
        observedValue: args.newValue,
        advancedTo: advanced,
        maxRatio: args.maxRatio,
        corroborations: next.observations,
      },
      'MNY-22: price feed anchor ratcheting one capped step toward corroborated new level (bounded recovery from sanity-bound wedge)',
    );
    // Loud on EVERY accepted advance: an anchor movement is operator-
    // visible, and the security property (a malicious walk is slow AND
    // loud) depends on each capped step paging, not only the rejections.
    notifyPriceFeedAnomaly({
      currency: args.currency,
      feed: args.feed,
      previousValue: args.previousValue ?? null,
      newValue: args.newValue,
      maxRatio: args.maxRatio,
    });
    return advanced;
  }

  // Not yet corroborated — reject this observation but remember the
  // streak so a sustained move converges rather than wedging.
  breachStreaks.set(key, next);
  log.error(
    {
      currency: args.currency,
      feed: args.feed,
      previousValue: args.previousValue,
      newValue: args.newValue,
      maxRatio: args.maxRatio,
      corroborations: next.observations,
      requiredCorroborations: REQUIRED_CORROBORATIONS,
    },
    'CF2-06: price feed rate jump exceeds the sanity bound — rejecting as implausible',
  );
  notifyPriceFeedAnomaly({
    currency: args.currency,
    feed: args.feed,
    previousValue: args.previousValue ?? null,
    newValue: args.newValue,
    maxRatio: args.maxRatio,
  });
  throw new Error(
    `Price feed rate jump for ${args.currency} exceeds sanity bound (${args.previousValue} → ${args.newValue})`,
  );
}
