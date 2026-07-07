#!/usr/bin/env node
/**
 * merchant-state.mjs — the per-merchant lifecycle ledger (media v2 plan M2).
 *
 * The pipeline had no durable record of where each merchant is in the pipeline,
 * so an apply had to GET the whole 3,400-merchant catalog every run to
 * rediscover what was already done. This is the single source of truth, keyed by
 * CTX id, stored durably in the git-tracked data/ dir (via paths.mjs):
 *
 *   "<ctxId>": {
 *     "sourced":  { "logo": true, "cover": true, "info": true },   // an asset exists
 *     "qc":       { "logo": "pass", "cover": "flag:text" },        // auto-QC verdict
 *     "reviewed": { "logo": "yes", "cover": null },                // human/vision verdict
 *     "applied":  { "logo": "2026-07-06T…Z", "cover": null },      // ISO ts once PUT succeeds
 *     "ctxHas":   { "logo": true, "cover": false }                 // last observed live state
 *   }
 *
 * Because `applied.<field>` is a timestamp, resume is a LOCAL filter — no network
 * re-scan. Every stage (source / qc / review / apply) upserts its slice here.
 *
 * API:
 *   loadState(file?) / saveState(state, file?)
 *   upsert(state, id, patch)   → deep-merge a slice into a merchant's record
 *   coverage(state)            → { total, sourced{}, reviewed{}, applied{} } counts
 *   needsApply(state, field)   → ids that are sourced + review-approved but not applied
 *
 * CLI:
 *   node merchant-state.mjs --self-test
 *   node merchant-state.mjs --coverage        # print the coverage board from data/
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachePath, dataPath } from './paths.mjs';

const FIELDS = ['logo', 'cover', 'info'];
const STATE_FILE = () => dataPath('merchant-state.json');

export function loadState(file = STATE_FILE()) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}
export function saveState(state, file = STATE_FILE()) {
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

/** Deep-merge (one level) a patch into a merchant's lifecycle record. Nested
 *  objects (sourced/qc/reviewed/applied/ctxHas) merge; scalars replace. */
export function upsert(state, id, patch) {
  const cur = state[id] || {};
  const merged = { ...cur };
  for (const [k, v] of Object.entries(patch || {})) {
    merged[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(cur[k] || {}), ...v } : v;
  }
  state[id] = merged;
  return state;
}

/** Coverage board: per field, how many merchants are sourced / review-approved
 *  / applied. reviewed counts only explicit 'yes'. */
export function coverage(state) {
  const ids = Object.keys(state);
  const out = { total: ids.length, sourced: {}, reviewed: {}, applied: {} };
  for (const f of FIELDS) {
    out.sourced[f] = ids.filter((id) => state[id]?.sourced?.[f]).length;
    out.reviewed[f] = ids.filter((id) => state[id]?.reviewed?.[f] === 'yes').length;
    out.applied[f] = ids.filter((id) => state[id]?.applied?.[f]).length;
  }
  return out;
}

/** Ids that still need <field> applied: an asset is sourced + review-approved
 *  but not yet applied. This is the apply queue — a local filter, no network. */
export function needsApply(state, field) {
  return Object.keys(state).filter(
    (id) =>
      state[id]?.sourced?.[field] &&
      state[id]?.reviewed?.[field] === 'yes' &&
      !state[id]?.applied?.[field],
  );
}

// ── CLI (only when run directly, never on import) ───────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--self-test')) {
  const s = {};
  upsert(s, 'm1', { sourced: { logo: true } });
  upsert(s, 'm1', { sourced: { cover: true }, reviewed: { logo: 'yes' } }); // merges, doesn't clobber
  upsert(s, 'm1', { applied: { logo: '2026-07-06T00:00:00Z' } });
  upsert(s, 'm2', { sourced: { logo: true }, reviewed: { logo: 'yes' } }); // sourced+approved, not applied
  upsert(s, 'm3', { sourced: { logo: true }, reviewed: { logo: 'no' } }); // rejected → not in apply queue
  const cov = coverage(s);
  const apply = needsApply(s, 'logo');
  const checks = {
    'upsert merges nested slices (no clobber)':
      s.m1.sourced.logo === true && s.m1.sourced.cover === true,
    'upsert keeps prior sibling slices':
      s.m1.reviewed.logo === 'yes' && s.m1.applied.logo.startsWith('2026'),
    'coverage counts sourced': cov.sourced.logo === 3,
    'coverage counts review-approved (only yes)': cov.reviewed.logo === 2,
    'coverage counts applied': cov.applied.logo === 1,
    'needsApply = sourced + approved + not-applied': apply.length === 1 && apply[0] === 'm2',
    'load/save round-trips': (() => {
      const tmp = cachePath('merchant-state-selftest/ms-selftest.json');
      mkdirSync(dirname(tmp), { recursive: true });
      saveState(s, tmp);
      return JSON.stringify(loadState(tmp)) === JSON.stringify(s);
    })(),
  };
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? '\nSELF-TEST PASS ✓' : '\nSELF-TEST FAIL ✗');
  process.exit(ok ? 0 : 1);
} else if (isMain && process.argv.includes('--coverage')) {
  console.log(JSON.stringify(coverage(loadState()), null, 2));
} else if (isMain) {
  console.log('usage: merchant-state.mjs --self-test | --coverage');
}
