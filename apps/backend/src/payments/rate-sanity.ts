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
 */
import { logger } from '../logger.js';
import { notifyPriceFeedAnomaly } from '../discord.js';

const log = logger.child({ area: 'rate-sanity' });

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
 * Validates a freshly-fetched rate against the last known-good value
 * for the same currency before it's accepted into a feed's cache.
 * Rejects (throws) an implausible jump instead of silently accepting
 * it — same "feed problem → throw → caller's tick-level catch defers"
 * posture each feed already uses for missing/non-positive rates, plus
 * a Discord page since a big swing (or an attack) needs operator eyes,
 * unlike a routine transient fetch failure.
 */
export function validateRateJump(args: {
  currency: string;
  feed: 'xlm' | 'fx';
  previousValue: number | undefined;
  newValue: number;
  maxRatio: number;
}): void {
  if (isPlausibleRateJump(args.previousValue, args.newValue, args.maxRatio)) return;
  log.error(
    {
      currency: args.currency,
      feed: args.feed,
      previousValue: args.previousValue,
      newValue: args.newValue,
      maxRatio: args.maxRatio,
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
