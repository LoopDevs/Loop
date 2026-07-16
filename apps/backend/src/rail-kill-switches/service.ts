/**
 * NS-04 — durable runtime rail kill/halt switches: service interface +
 * enforcement helper.
 *
 * Read `types.ts` and
 * `docs/audit/audit-2026-07/ns-04-kill-switches-design.md` first. The
 * REAL, table-backed implementation lives in `./db-service.ts`
 * (`DbKillSwitchService` + the `killSwitchService` singleton the rails
 * and the admin API share); this file holds only the interface, the
 * `RailHaltedError` enforcement throw, and the pure `assertRailNotHalted`
 * delegator (no DB access of its own, so it stays trivially testable with
 * a fake service).
 *
 * Safety posture (this is a MONEY app): the real service FAILS CLOSED on
 * a durable-store read error (an unreadable switch is treated as HALTED),
 * mirroring the CFG-06 / A4-047 precedent in `../kill-switches.ts`. See
 * `./db-service.ts` for that logic.
 */
import type { HaltArgs, Rail, RailHaltState, ResumeArgs } from './types.js';

/**
 * Durable, admin-toggleable halt state for the four money rails.
 *
 * READ methods (`isHalted` / `getState` / `listStates`) are consumed by
 * enforcement at rail entry points and by the admin "list" endpoint.
 * WRITE methods (`halt` / `resume`) are the admin-plane mutations, each
 * of which must be audited (ADR-017 idempotency + Discord fanout) and
 * step-up gated (ADR-028) at the route layer.
 */
export interface KillSwitchService {
  /**
   * `true` when `rail` is currently halted. The hot-path predicate an
   * enforcement check calls before letting a new operation proceed.
   * The real impl MUST fail closed (return `true`) on a store error.
   */
  isHalted(rail: Rail): Promise<boolean>;
  /** Full current state for one rail (for the admin detail view). */
  getState(rail: Rail): Promise<RailHaltState>;
  /** Current state for every rail (for the admin list endpoint). */
  listStates(): Promise<RailHaltState[]>;
  /** Halt a rail. Admin-plane, audited + step-up gated at the route. */
  halt(args: HaltArgs): Promise<RailHaltState>;
  /** Resume a rail. Admin-plane, audited + step-up gated at the route. */
  resume(args: ResumeArgs): Promise<RailHaltState>;
}

/**
 * Thrown by `assertRailNotHalted` when a rail is halted. Rails should
 * catch/translate this into their surface's shape (e.g. an HTTP handler
 * → 503 `RAIL_HALTED`; a worker tick → a no-op early return so queued
 * rows re-drain once the rail resumes — see the design doc for the
 * per-rail translation table).
 */
export class RailHaltedError extends Error {
  readonly rail: Rail;

  constructor(rail: Rail) {
    super(`${rail} rail is halted`);
    this.name = 'RailHaltedError';
    this.rail = rail;
  }
}

/**
 * Enforcement helper. Given a `KillSwitchService`, throws
 * `RailHaltedError` when the rail is halted; otherwise returns. Used by
 * the HTTP-shaped rail entry points (refund primitives, vault mutating
 * ops) which translate the throw into a 503 `RAIL_HALTED`. The worker
 * ticks (deposit / payout) instead read `service.isHalted(rail)`
 * directly and early-return an empty tick so queued rows re-drain on
 * resume (block-new-only) — a throw there would just be caught and
 * logged, so the boolean read is the clearer shape.
 *
 * Intentionally a thin delegator with no table access of its own — it
 * stays trivially unit-testable against a fake service. The production
 * service is the `killSwitchService` singleton in `./db-service.ts`.
 */
export async function assertRailNotHalted(service: KillSwitchService, rail: Rail): Promise<void> {
  if (await service.isHalted(rail)) {
    throw new RailHaltedError(rail);
  }
}
