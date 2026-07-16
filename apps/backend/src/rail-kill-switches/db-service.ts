/**
 * NS-04 — the REAL, table-backed `KillSwitchService` (migration 0072).
 *
 * Reads/writes `rail_kill_switches` (one row per rail). This is the
 * production implementation the scaffold's `UnwiredKillSwitchService`
 * placeholder promised; enforcement at each rail entry point and the
 * admin halt/resume/list API both go through the module-level singleton
 * `killSwitchService` exported at the bottom.
 *
 * Safety posture (this is a MONEY app):
 *
 *   - FAIL CLOSED on a read error. If `rail_kill_switches` is
 *     unreachable or the query throws, `isHalted` returns `true` — the
 *     rail is treated as HALTED and money stays put. This mirrors the
 *     CFG-06 / A4-047 precedent for the env kill switches (an
 *     unreadable/garbage switch is treated as ENGAGED). A DB blip
 *     halting all four rails is the accepted, safe residual (design §7
 *     Q6, confirmed).
 *
 *   - Default "not halted" is a PROTECTED CLASS. A MISSING row reads as
 *     `halted: false` (the migration seeds all four rails open, but
 *     enforcement never depends on the seed existing). Only an explicit
 *     `halted = true` row halts a rail.
 *
 *   - Block-new-only. `isHalted` is the hot-path predicate an
 *     enforcement check reads before letting a NEW operation start; it
 *     never touches in-flight work.
 *
 * Boot-flag precedence (design §7 Q8): a rail is halted if EITHER its
 * boot flag disables it OR its row says halted (logical OR). This
 * service only owns the row half — the boot flags (`LOOP_WORKERS_ENABLED`
 * / `LOOP_VAULTS_ENABLED`) are enforced INDEPENDENTLY and earlier at each
 * entry point (the watcher/payout workers aren't scheduled when workers
 * are disabled; `requireVaultsEnabled()` throws before the vault-rail
 * check runs). So the OR holds structurally, and no row value can ever
 * force a boot-disabled rail back on.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { railKillSwitches } from '../db/schema.js';
import { logger } from '../logger.js';
import { RAILS, type HaltArgs, type Rail, type RailHaltState, type ResumeArgs } from './types.js';
import type { KillSwitchService } from './service.js';

const log = logger.child({ area: 'rail-kill-switches' });

type Row = typeof railKillSwitches.$inferSelect;

function rowToState(row: Row): RailHaltState {
  return {
    rail: row.rail,
    halted: row.halted,
    reason: row.reason,
    actorUserId: row.actorUserId,
    updatedAt: row.updatedAt,
  };
}

/** Synthesised "never toggled / not halted" state for a rail with no row. */
function defaultState(rail: Rail): RailHaltState {
  return { rail, halted: false, reason: null, actorUserId: null, updatedAt: new Date(0) };
}

export class DbKillSwitchService implements KillSwitchService {
  /**
   * Hot-path predicate: `true` iff the rail is currently halted. A
   * missing row → `false` (not halted). A store read error → `true`
   * (FAIL CLOSED — money stays put). Never throws.
   */
  async isHalted(rail: Rail): Promise<boolean> {
    try {
      const [row] = await db
        .select({ halted: railKillSwitches.halted })
        .from(railKillSwitches)
        .where(eq(railKillSwitches.rail, rail));
      // Missing row is the mandated default: not halted.
      return row?.halted ?? false;
    } catch (err) {
      // FAIL CLOSED. An unreadable switch is treated as ENGAGED so a DB
      // outage can't silently keep a rail open when its state is unknown.
      log.error(
        { err, rail },
        'rail kill-switch read failed — failing CLOSED (rail treated as HALTED)',
      );
      return true;
    }
  }

  /** Full current state for one rail (admin detail); missing row → default. */
  async getState(rail: Rail): Promise<RailHaltState> {
    const [row] = await db.select().from(railKillSwitches).where(eq(railKillSwitches.rail, rail));
    return row === undefined ? defaultState(rail) : rowToState(row);
  }

  /**
   * Current state for every rail (admin list). Always returns all four
   * rails in a stable order, synthesising a default for any rail whose
   * row is somehow absent, so the admin UI is complete regardless of the
   * seed.
   */
  async listStates(): Promise<RailHaltState[]> {
    const rows = await db.select().from(railKillSwitches);
    const byRail = new Map<Rail, RailHaltState>(rows.map((r) => [r.rail, rowToState(r)]));
    return RAILS.map((rail) => byRail.get(rail) ?? defaultState(rail));
  }

  /** Halt a rail (UPSERT halted=true + reason + actor). Audited at the route. */
  async halt(args: HaltArgs): Promise<RailHaltState> {
    return this.write(args.rail, true, args.reason, args.actorUserId);
  }

  /** Resume a rail (UPSERT halted=false + reason + actor). Audited at the route. */
  async resume(args: ResumeArgs): Promise<RailHaltState> {
    return this.write(args.rail, false, args.reason, args.actorUserId);
  }

  private async write(
    rail: Rail,
    halted: boolean,
    reason: string,
    actorUserId: string,
  ): Promise<RailHaltState> {
    const [row] = await db
      .insert(railKillSwitches)
      .values({ rail, halted, reason, actorUserId })
      .onConflictDoUpdate({
        target: railKillSwitches.rail,
        set: { halted, reason, actorUserId, updatedAt: new Date() },
      })
      .returning();
    if (row === undefined) {
      // .returning() on a successful upsert always yields one row.
      throw new Error(`rail_kill_switches upsert for ${rail} returned no row`);
    }
    return rowToState(row);
  }
}

/**
 * Process-wide singleton the rails + admin API share. A rail entry point
 * imports this and passes it to `assertRailNotHalted(killSwitchService,
 * rail)`; the admin handler calls `.halt` / `.resume` / `.listStates`.
 */
export const killSwitchService: KillSwitchService = new DbKillSwitchService();
