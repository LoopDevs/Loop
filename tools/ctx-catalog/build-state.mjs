#!/usr/bin/env node
/**
 * build-state.mjs — populate the merchant-state ledger (M2) from the recovered
 * data/ manifests, so the coverage board + apply queue reflect the real
 * ~1,156-merchant working set instead of an empty ledger.
 *
 * Reads the git-tracked manifests and derives each merchant's lifecycle slice:
 *   - ctx-media-final.json  → sourced.logo (logoUrl), sourced.cover (headerUrl),
 *                             category (vertical), qc hint (logoSource)
 *   - ctx-info.json         → sourced.info (has description/intro)
 *   - review-decisions.json → reviewed.logo / reviewed.cover ('yes'|'no')
 *
 * It does NOT set `applied` — that's only ever written by a real apply
 * (ctx-write). So after building, `merchant-state --coverage` shows what's
 * sourced + reviewed, and `ctx-write` can compute the apply queue locally.
 *
 * API:  buildState({ media, info, decisions }) → state
 * CLI:  node build-state.mjs --self-test
 *       node build-state.mjs --build            # writes data/merchant-state.json + prints coverage
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dataPath } from './paths.mjs';
import { upsert, saveState, coverage } from './merchant-state.mjs';

const loadJson = (name) => {
  const f = dataPath(name);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
};

export function buildState({ media = {}, info = {}, decisions = {} } = {}) {
  const state = {};
  for (const [id, m] of Object.entries(media)) {
    if (!m) continue;
    const sourced = {};
    if (m.logoUrl) sourced.logo = true;
    if (m.headerUrl || m.cardImageUrl) sourced.cover = true;
    const patch = { sourced };
    if (m.vertical) patch.category = m.vertical;
    if (m.logoSource) patch.qc = { logoSource: m.logoSource };
    upsert(state, id, patch);
  }
  for (const [id, inf] of Object.entries(info)) {
    if (inf && (inf.description || inf.intro)) upsert(state, id, { sourced: { info: true } });
  }
  for (const [id, d] of Object.entries(decisions)) {
    if (!d) continue;
    const reviewed = {};
    if (d.logo) reviewed.logo = d.logo;
    if (d.cover) reviewed.cover = d.cover;
    if (Object.keys(reviewed).length) upsert(state, id, { reviewed });
  }
  return state;
}

// ── CLI (only when run directly, never on import) ───────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--self-test')) {
  const state = buildState({
    media: {
      m1: { logoUrl: 'x', headerUrl: 'y', vertical: 'retail', logoSource: 'logo.dev' },
      m2: { logoUrl: 'z' }, // logo only
      m3: {}, // known, nothing sourced
    },
    info: { m1: { description: 'A real description here.' } },
    decisions: { m1: { logo: 'yes', cover: 'no' }, m2: { logo: 'yes' } },
  });
  const cov = coverage(state);
  const checks = {
    'logoUrl → sourced.logo': state.m1.sourced.logo === true && state.m2.sourced.logo === true,
    'headerUrl → sourced.cover': state.m1.sourced.cover === true && !state.m2.sourced?.cover,
    'info description → sourced.info': state.m1.sourced.info === true && !state.m2.sourced?.info,
    'vertical → category, logoSource → qc':
      state.m1.category === 'retail' && state.m1.qc.logoSource === 'logo.dev',
    'review decisions → reviewed':
      state.m1.reviewed.logo === 'yes' &&
      state.m1.reviewed.cover === 'no' &&
      state.m2.reviewed.logo === 'yes',
    'never sets applied': !state.m1.applied && !state.m2.applied,
    'coverage reflects the build':
      cov.sourced.logo === 2 && cov.sourced.cover === 1 && cov.reviewed.logo === 2,
  };
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? '\nSELF-TEST PASS ✓' : '\nSELF-TEST FAIL ✗');
  process.exit(ok ? 0 : 1);
} else if (isMain && process.argv.includes('--build')) {
  const state = buildState({
    media: loadJson('ctx-media-final.json'),
    info: loadJson('ctx-info.json'),
    decisions: loadJson('review-decisions.json'),
  });
  saveState(state);
  console.log(`Wrote merchant-state.json (${Object.keys(state).length} merchants)`);
  console.log(JSON.stringify(coverage(state), null, 2));
} else if (isMain) {
  console.log('usage: build-state.mjs --self-test | --build');
}
