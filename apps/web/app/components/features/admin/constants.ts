/**
 * Shared constants for the admin surface.
 */

/**
 * Maximum absolute magnitude, in MINOR units, that an admin money
 * write (credit adjustment / emission / refund) may carry — i.e.
 * ±10,000,000 minor = ±100,000 major units.
 *
 * This mirrors the authoritative backend bound enforced in
 * `apps/backend/src/admin/{credit-adjustments,emissions,refunds}.ts`
 * (all reject magnitude `> 10_000_000n`). It exists client-side only
 * so the forms can reject an out-of-range amount pre-submit rather
 * than bouncing off a backend 400; the backend remains the guard.
 * Keep this value in lockstep with that bound.
 */
export const ADMIN_WRITE_MAX_ABS_MINOR = 10_000_000n;
