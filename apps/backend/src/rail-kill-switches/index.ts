/**
 * NS-04 — durable runtime rail kill/halt switches (barrel).
 *
 * Types + service interface + `RailHaltedError` + the `assertRailNotHalted`
 * enforcement helper, plus the table-backed `DbKillSwitchService` and the
 * process-wide `killSwitchService` singleton the rails + admin API share.
 *
 * See `types.ts`, `service.ts`, `db-service.ts`, and
 * `docs/audit/audit-2026-07/ns-04-kill-switches-design.md`.
 */
export type { HaltArgs, Rail, RailHaltState, ResumeArgs } from './types.js';
export { RAILS } from './types.js';
export { assertRailNotHalted, RailHaltedError, type KillSwitchService } from './service.js';
export { DbKillSwitchService, killSwitchService } from './db-service.js';
