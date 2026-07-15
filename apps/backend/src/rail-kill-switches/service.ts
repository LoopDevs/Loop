/**
 * NS-04 — durable runtime rail kill/halt switches: service interface,
 * enforcement helper, and an UNWIRED placeholder implementation.
 *
 * DESIGN SCAFFOLD ONLY — read `types.ts` and
 * `docs/audit/audit-2026-07/ns-04-kill-switches-design.md` first.
 *
 * Safety posture (important — this is a MONEY app):
 *   - Nothing here is imported by a live rail. The enforcement helper
 *     `assertRailNotHalted` is provided but NOT called at any rail entry
 *     point yet — wiring it needs the `rail_kill_switches` migration
 *     (0071+) AND an agreed halt policy (both are the human's call).
 *   - The placeholder `UnwiredKillSwitchService` does NOT read a
 *     not-yet-existing table and does NOT throw from its READ path. Its
 *     reads report "not halted" (the mandated default) so that if it were
 *     ever accidentally wired, a rail would keep its CURRENT behaviour
 *     (no halt) rather than crash. Its WRITE path throws loudly, because
 *     silently "succeeding" a halt that was never persisted would be
 *     worse than an error.
 *   - The REAL implementation (`DbKillSwitchService`, a later PR) MUST
 *     fail CLOSED on a durable-store read error, mirroring the
 *     CFG-06 / A4-047 precedent in `../kill-switches.ts` (an
 *     unreadable/garbage switch is treated as ENGAGED). That decision is
 *     called out as a policy question; do not assume it here.
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
 * Thrown by the UNWIRED placeholder's write path. Signals that the
 * durable `rail_kill_switches` store does not exist yet (migration
 * 0071+ pending) so a halt/resume cannot be persisted.
 */
export class KillSwitchNotProvisionedError extends Error {
  constructor(operation: string) {
    super(`rail kill-switch store not provisioned (NS-04 migration 0071+ pending): ${operation}`);
    this.name = 'KillSwitchNotProvisionedError';
  }
}

/**
 * Enforcement helper (STUB — provided, deliberately NOT wired into any
 * rail yet). Given an injected `KillSwitchService`, throws
 * `RailHaltedError` when the rail is halted; otherwise returns.
 *
 * This is intentionally a thin delegator with no table access of its
 * own: it becomes active only once (a) a real service backed by the
 * durable table is injected and (b) a rail entry point actually calls
 * it. Both steps are out of scope for this scaffold. The enforcement
 * points where this SHOULD be called are listed in the design doc:
 *   - deposit → runPaymentWatcherTick (payments/watcher.ts)
 *   - payout  → runPayoutTick        (payments/payout-worker.ts)
 *   - vault   → requireVaultsEnabled (credits/vaults/vault-client.ts)
 *   - refund  → applyAdminRefund (credits/refunds.ts) + refundDeposit
 *               (payments/deposit-refund.ts)
 */
export async function assertRailNotHalted(service: KillSwitchService, rail: Rail): Promise<void> {
  if (await service.isHalted(rail)) {
    throw new RailHaltedError(rail);
  }
}

/**
 * UNWIRED placeholder implementation. NOT backed by durable state and
 * NOT instantiated anywhere in live code — it exists only so the
 * interface has a compiling reference impl for the design + future
 * tests. Replace with `DbKillSwitchService` once migration 0071+ lands.
 *
 * Reads report the mandated default (`halted: false`); writes throw
 * `KillSwitchNotProvisionedError` (see the file header for why the read
 * and write paths differ).
 */
export class UnwiredKillSwitchService implements KillSwitchService {
  isHalted(_rail: Rail): Promise<boolean> {
    // TODO(NS-04): replace with a durable read of `rail_kill_switches`
    // that fails CLOSED on error. Until then: never halts (inert).
    return Promise.resolve(false);
  }

  getState(rail: Rail): Promise<RailHaltState> {
    // TODO(NS-04): read the row; synthesize a default until the table exists.
    return Promise.resolve({
      rail,
      halted: false,
      reason: null,
      actorUserId: null,
      updatedAt: new Date(0),
    });
  }

  listStates(): Promise<RailHaltState[]> {
    // TODO(NS-04): SELECT * FROM rail_kill_switches. Empty store default.
    return Promise.resolve([]);
  }

  halt(args: HaltArgs): Promise<RailHaltState> {
    // TODO(NS-04): UPSERT halted=true in the same txn as the audit write.
    return Promise.reject(new KillSwitchNotProvisionedError(`halt(${args.rail})`));
  }

  resume(args: ResumeArgs): Promise<RailHaltState> {
    // TODO(NS-04): UPSERT halted=false in the same txn as the audit write.
    return Promise.reject(new KillSwitchNotProvisionedError(`resume(${args.rail})`));
  }
}
