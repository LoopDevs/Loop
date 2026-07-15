/**
 * NS-04 — durable runtime rail kill/halt switches (DESIGN SCAFFOLD).
 *
 * Barrel for the rail-halt types + service interface + (unwired)
 * enforcement helper. See `types.ts`, `service.ts`, and
 * `docs/audit/audit-2026-07/ns-04-kill-switches-design.md`.
 *
 * NOT wired into any live rail — importing from here has no runtime
 * effect on the rails until the `rail_kill_switches` migration (0071+)
 * lands and enforcement is deliberately wired under an agreed policy.
 */
export type { HaltArgs, Rail, RailHaltState, ResumeArgs } from './types.js';
export { RAILS } from './types.js';
export {
  assertRailNotHalted,
  KillSwitchNotProvisionedError,
  RailHaltedError,
  UnwiredKillSwitchService,
  type KillSwitchService,
} from './service.js';
