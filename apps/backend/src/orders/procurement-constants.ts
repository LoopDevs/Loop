/**
 * Procurement-sweep timing constants (ADR 010), split out of
 * `procurement-worker.ts` into their own zero-dependency module.
 *
 * `procurement-worker.ts` transitively imports the full procurement
 * ladder (`procure-one.ts` → Stellar SDK, CTX client, Discord, …), so
 * anything that just wants the numeric cutoff — e.g. A5-6's stuck-
 * orders triage read, which pins its early-warning default against
 * this terminal-action cutoff (see `admin/stuck-orders.ts` and
 * `admin/__tests__/stuck-orders.test.ts`) — can import this instead
 * without dragging that graph into a lightweight unit test.
 */

/**
 * How stale a `procuring` order must be before the recovery sweep
 * (`sweepStuckProcurement`) marks it failed. 15 minutes is plenty —
 * CTX procurement in the happy path completes in a few seconds;
 * anything hanging at the 15-minute mark is a crashed worker or a
 * deep upstream issue the user shouldn't be left waiting on.
 */
export const PROCUREMENT_TIMEOUT_MS = 15 * 60 * 1000;
