#!/usr/bin/env node
/**
 * ctx-write.mjs — the safe-apply primitives (media v2 plan M3).
 *
 * The catalog write scripts mostly fire straight at production with no uniform
 * dry-run / plan / idempotency, and the ONE good applier (ctx-apply) is
 * archived + marked do-not-run. This module is the shared safe-write core every
 * applier should use:
 *
 *   - DRY-RUN BY DEFAULT — nothing writes unless `--apply` is passed.
 *   - PLAN PREVIEW — print what would change + write it to data/plans/<ts>.json
 *     before any write.
 *   - IDEMPOTENT FROM LOCAL STATE — skip anything merchant-state already records
 *     as applied; no whole-catalog GET to rediscover progress.
 *   - THROTTLED — a delay between writes so a bulk run doesn't hammer CTX.
 *
 * The un-archive + rewrite of ctx-apply.mjs onto these primitives is the wiring
 * follow-up; the safety logic + gate live (and are tested) here.
 *
 * API:
 *   applyMode(argv?)                       → { dryRun, limit }
 *   buildApplyPlan(state, field)           → { field, ids, count }
 *   formatPlan(plan)                       → printable string
 *   runApply(state, field, writeFn, opts)  → { field, planned, applied, skipped, errors, dryRun }
 *
 * CLI: node ctx-write.mjs --self-test
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { needsApply, upsert } from './merchant-state.mjs';
import { dataPath } from './paths.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The write gate: dry-run unless --apply. --limit N caps the batch. */
export function applyMode(argv = process.argv.slice(2)) {
  const li = argv.indexOf('--limit');
  return {
    dryRun: !argv.includes('--apply'),
    limit: li >= 0 ? Number(argv[li + 1]) : Infinity,
  };
}

/** What still needs <field> applied, straight from the ledger (no network). */
export function buildApplyPlan(state, field) {
  const ids = needsApply(state, field);
  return { field, ids, count: ids.length };
}

export function formatPlan(plan) {
  const sample = plan.ids.slice(0, 5).join(', ');
  return `apply ${plan.field}: ${plan.count} merchant(s)${plan.count ? ` [${sample}${plan.count > 5 ? ', …' : ''}]` : ''}`;
}

/** Persist a plan to data/plans/<field>-<stamp>.json before any write, so every
 *  run leaves an auditable record of what it intended to change. */
export function writePlanFile(plan, stamp) {
  const dir = dataPath('plans');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* exists */
  }
  const file = `${dir}/${plan.field}-${stamp}.json`;
  writeFileSync(file, JSON.stringify(plan, null, 2) + '\n');
  return file;
}

/**
 * Run an apply: dry-run by default. Only writes when `apply` is true; skips
 * anything already applied (idempotent from state), records the applied
 * timestamp, and throttles between writes. `writeFn(id)` does the real PUT;
 * `nowIso` is injectable for testing.
 */
export async function runApply(
  state,
  field,
  writeFn,
  {
    apply = false,
    throttleMs = 700,
    limit = Infinity,
    nowIso = () => new Date().toISOString(),
  } = {},
) {
  const plan = buildApplyPlan(state, field);
  const ids = plan.ids.slice(0, limit);
  const result = { field, planned: plan.count, applied: 0, skipped: 0, errors: 0, dryRun: !apply };
  for (const id of ids) {
    if (state[id]?.applied?.[field]) {
      result.skipped++; // idempotent — already done
      continue;
    }
    if (!apply) {
      result.skipped++; // dry-run — never writes
      continue;
    }
    try {
      await writeFn(id);
      upsert(state, id, { applied: { [field]: nowIso() } });
      result.applied++;
      if (throttleMs) await sleep(throttleMs);
    } catch {
      result.errors++;
    }
  }
  return result;
}

// ── CLI (only when run directly, never on import) ───────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--self-test')) {
  const mkState = () => ({
    m1: { sourced: { logo: true }, reviewed: { logo: 'yes' } }, // to apply
    m2: { sourced: { logo: true }, reviewed: { logo: 'yes' } }, // to apply
    done: {
      sourced: { logo: true },
      reviewed: { logo: 'yes' },
      applied: { logo: '2026-01-01T00:00:00Z' },
    }, // already
    rej: { sourced: { logo: true }, reviewed: { logo: 'no' } }, // rejected → not in plan
  });
  const writes = [];
  const writeFn = (id) => writes.push(id);

  // dry-run: never writes
  const s1 = mkState();
  const dry = await runApply(s1, 'logo', writeFn, { throttleMs: 0 });
  const dryWroteNothing = writes.length === 0 && dry.dryRun === true && dry.applied === 0;

  // live: writes the two pending; the already-applied + rejected are pre-excluded
  // from the plan by needsApply, so they're never written.
  writes.length = 0;
  const s2 = mkState();
  const live = await runApply(s2, 'logo', writeFn, {
    apply: true,
    throttleMs: 0,
    nowIso: () => '2026-07-07T00:00:00Z',
  });
  const liveWrites = [...writes];
  // re-run on the now-applied state → the plan is empty, so nothing writes again
  writes.length = 0;
  const rerun = await runApply(s2, 'logo', writeFn, { apply: true, throttleMs: 0 });

  const checks = {
    'applyMode: dry-run by default': applyMode([]).dryRun === true,
    'applyMode: --apply flips to live + reads --limit':
      applyMode(['--apply', '--limit', '3']).dryRun === false &&
      applyMode(['--limit', '3']).limit === 3,
    'plan lists only sourced+approved+unapplied': buildApplyPlan(mkState(), 'logo').count === 2,
    'formatPlan is printable': /apply logo: 2 merchant/.test(
      formatPlan(buildApplyPlan(mkState(), 'logo')),
    ),
    'dry-run writes NOTHING': dryWroteNothing,
    'live writes exactly the 2 pending, never done/rej':
      live.applied === 2 &&
      liveWrites.length === 2 &&
      liveWrites.includes('m1') &&
      liveWrites.includes('m2') &&
      !liveWrites.includes('done') &&
      !liveWrites.includes('rej'),
    'live records applied timestamp': s2.m1.applied.logo === '2026-07-07T00:00:00Z',
    'already-applied timestamp not overwritten': s2.done.applied.logo === '2026-01-01T00:00:00Z',
    're-run is idempotent (applies nothing)': rerun.applied === 0 && writes.length === 0,
  };
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? '\nSELF-TEST PASS ✓' : '\nSELF-TEST FAIL ✗');
  process.exit(ok ? 0 : 1);
} else if (isMain) {
  console.log('usage: ctx-write.mjs --self-test  (safe-apply primitives; import into an applier)');
}
