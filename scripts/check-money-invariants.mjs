#!/usr/bin/env node
/**
 * Money-invariant DB-layer presence check (T0-3,
 * docs/money-auth-worklist.md Phase 2).
 *
 * docs/invariants.md documents a set of money invariants enforced at
 * the DB tier — a trigger, a unique index, a CHECK constraint — on the
 * theory that a DB-tier fence "cannot be bypassed by any writer".
 * That's true once the object exists. Nothing previously asserted that
 * it STILL exists: `check-migration-parity.mjs` only proves the
 * migration chain and `schema.ts` agree with EACH OTHER, so a diff
 * that drops a money-critical trigger/index/CHECK from BOTH sides
 * consistently — the exact "silently demotes an invariant from a
 * DB/test tier down to convention" failure mode AGENTS.md calls out —
 * passes migration-parity clean. This script closes that gap: it
 * statically replays the migration chain's CREATE/DROP events for a
 * fixed list of money-critical objects (mirroring the "DB:" rows in
 * docs/invariants.md) and fails if any object is missing, or if its
 * definition has been narrowed below a documented shape assertion
 * (e.g. the emission-conservation trigger's kind set, the orders
 * state-machine CHECK's allowed states).
 *
 * Deliberately static (no live postgres) so it can run in the CI
 * Quality job (a REQUIRED merge check per AGENTS.md) and in
 * `npm run verify` — the money-invariant presence gate does not need
 * to wait on branch-protection ever adding `flywheel-integration`
 * (the real-DB job that runs `check-migration-parity` + the ledger
 * assertion) to the required set. See docs/money-auth-worklist.md
 * T0-3 for the 👤 operator follow-up that promotes flywheel-integration
 * too, belt-and-suspenders.
 *
 * Method: concatenate every migrations/*.sql file in filename order
 * (the 4-digit numeric prefix IS the apply order), then for each
 * tracked object walk EVERY create/drop event for that object's name
 * in file order and keep only the LAST one (last-write-wins — the
 * same semantics as replaying the migrations for real). An object
 * whose last event is a DROP, or that has no CREATE event at all, is
 * reported missing. An object whose last event is a CREATE is checked
 * against its `mustInclude` substrings (case-sensitive, matched
 * against the captured definition text) to catch a narrowed-but-still-
 * present redefinition (e.g. dropping 'interest_mint' from the
 * re-entry trigger's kind set without removing the trigger itself).
 *
 * This is intentionally a TEXT-level replay, not a real SQL parser —
 * proportionate to a fast, dependency-free CI gate. It is a
 * complement to, not a replacement for, `check-migration-parity.mjs`
 * (which validates via a real postgres in flywheel-integration) and
 * the integration ledger-drift assertion (INV-1).
 *
 * Usage: node scripts/check-money-invariants.mjs
 * Runs in `npm run verify` and the CI Quality job.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'apps/backend/src/db/migrations');

// ── 1. Load + concatenate migrations in apply order ───────────────────────

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort(); // 4-digit zero-padded numeric prefix sorts lexicographically == apply order

if (files.length < 40) {
  console.error(
    `check-money-invariants: only found ${files.length} migration files — the migrations-dir scan broke; fix the script before trusting it.`,
  );
  process.exit(2);
}

/** @type {{file: string, start: number, end: number}[]} */
const spans = [];
let corpus = '';
for (const f of files) {
  const text = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
  const start = corpus.length;
  corpus += text + '\n';
  spans.push({ file: f, start, end: corpus.length });
}

function fileAt(pos) {
  for (const s of spans) {
    if (pos >= s.start && pos < s.end) return s.file;
  }
  return '(unknown)';
}

/** Balanced-paren capture starting at the index of an opening '('. */
function captureParenBody(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return text.slice(openIdx);
}

// ── 2. Extract create/drop "events" per object kind, in corpus order ──────
// Each event: { name, kind: 'create'|'drop', pos, body }

/** @type {Map<string, {pos: number, body: string}[]>} */
const indexCreates = new Map();
/** @type {Map<string, number[]>} */
const indexDrops = new Map();
/** @type {Map<string, {pos: number, body: string}[]>} */
const constraintCreates = new Map();
/** @type {Map<string, number[]>} */
const constraintDrops = new Map();
/** @type {Map<string, {pos: number, body: string}[]>} */
const triggerCreates = new Map();
/** @type {Map<string, number[]>} */
const triggerDrops = new Map();
/** @type {Map<string, {pos: number, body: string}[]>} */
const functionCreates = new Map();

function pushEvent(map, name, entry) {
  const list = map.get(name) ?? [];
  list.push(entry);
  map.set(name, list);
}
function pushDrop(map, name, pos) {
  const list = map.get(name) ?? [];
  list.push(pos);
  map.set(name, list);
}

// CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ... ; — lazy-match to the
// next ';'. None of the tracked index definitions contain a semicolon
// inside their body (no string literals with ';' in this repo's
// migrations), so this is safe.
for (const m of corpus.matchAll(
  /CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?[\s\S]*?;/g,
)) {
  pushEvent(indexCreates, m[1], { pos: m.index, body: m[0] });
}
for (const m of corpus.matchAll(
  /DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/g,
)) {
  pushDrop(indexDrops, m[1], m.index);
}

// CONSTRAINT name CHECK ( ... ) — covers both the inline
// `CREATE TABLE (... CONSTRAINT "x" CHECK (...))` shape and the
// `ALTER TABLE t ADD CONSTRAINT x CHECK (...)` shape (same literal
// substring). Balanced-paren capture handles nested parens.
for (const m of corpus.matchAll(/CONSTRAINT\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s+CHECK\s*\(/g)) {
  const openIdx = m.index + m[0].length - 1;
  const body = captureParenBody(corpus, openIdx);
  pushEvent(constraintCreates, m[1], { pos: m.index, body });
}
for (const m of corpus.matchAll(
  /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/g,
)) {
  pushDrop(constraintDrops, m[1], m.index);
}

// CREATE TRIGGER name ... ; — lazy-match to next ';' (trigger WHEN
// clauses in this repo are plain boolean expressions with no
// semicolons).
for (const m of corpus.matchAll(/CREATE\s+TRIGGER\s+"?([A-Za-z_][A-Za-z0-9_]*)"?[\s\S]*?;/g)) {
  pushEvent(triggerCreates, m[1], { pos: m.index, body: m[0] });
}
for (const m of corpus.matchAll(
  /DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/g,
)) {
  pushDrop(triggerDrops, m[1], m.index);
}

// CREATE [OR REPLACE] FUNCTION name(...) ... $$ ... $$ LANGUAGE ...;
// Capture the dollar-quoted body between the first and second `$$`
// after the signature. Functions are never DROPped in this repo (only
// redefined via CREATE OR REPLACE), so no drop-tracking is needed.
for (const m of corpus.matchAll(
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/g,
)) {
  const sigEnd = m.index + m[0].length;
  const firstDollar = corpus.indexOf('$$', sigEnd);
  if (firstDollar === -1) continue;
  const secondDollar = corpus.indexOf('$$', firstDollar + 2);
  if (secondDollar === -1) continue;
  const body = corpus.slice(m.index, secondDollar + 2);
  pushEvent(functionCreates, m[1], { pos: m.index, body });
}

/**
 * Last-write-wins resolution: given all create events and all drop
 * positions for a name, return the winning create event's body, or
 * null if the object is absent (never created, or last event was a
 * drop).
 */
function resolve(name, creates, drops) {
  const createList = creates.get(name) ?? [];
  const dropList = drops.get(name) ?? [];
  if (createList.length === 0) return null;
  const lastCreate = createList[createList.length - 1];
  const lastDropPos = dropList.length > 0 ? dropList[dropList.length - 1] : -1;
  if (lastDropPos > lastCreate.pos) return null;
  return lastCreate;
}

// ── 3. The tracked money-critical objects ──────────────────────────────────
// Each entry cross-references the docs/invariants.md invariant it backs
// (the "DB:" enforcement-tier rows) so the two documents stay in sync —
// adding a DB-tier invariant to invariants.md is the natural trigger to
// add its presence assertion here, and vice versa.

const REQUIRED_FUNCTIONS = [
  {
    name: 'assert_emission_conservation',
    inv: 'INV-3 (no unbacked LOOP: on-chain emitted <= mirror liability)',
    mustInclude: [
      "'order_cashback'",
      "'emission'",
      "'interest_mint'",
      "kind = 'burn'",
      'FOR UPDATE',
      'check_violation',
    ],
  },
];

const REQUIRED_TRIGGERS = [
  {
    name: 'pending_payouts_emission_conservation',
    inv: 'INV-3 (fresh emission-row insert is checked before it can materialise on-chain)',
    mustInclude: ["NEW.kind = 'emission'"],
  },
  {
    name: 'pending_payouts_mint_reentry_conservation',
    inv: 'INV-3 (admin retry re-entering a failed mint row is re-checked, not exempted)',
    mustInclude: ["'emission'", "'order_cashback'", "'interest_mint'"],
  },
];

const REQUIRED_INDEXES = [
  {
    name: 'credit_transactions_reference_unique',
    inv: 'INV-8 (refunds and cashback are single-issue per order)',
    mustInclude: ["'cashback'", "'refund'", "'spend'", "'withdrawal'"],
  },
  {
    name: 'pending_payouts_active_emission_unique',
    inv: 'INV-9 (one outbound payment per emission intent)',
    mustInclude: ["kind = 'emission'"],
  },
  {
    name: 'pending_payouts_order_unique',
    inv: 'INV-9 (one outbound payment per order-cashback intent)',
    mustInclude: ["kind = 'order_cashback'"],
  },
  {
    name: 'pending_payouts_burn_order_unique',
    inv: 'INV-9 (one outbound burn per redemption order)',
    mustInclude: ["kind = 'burn'"],
  },
  {
    name: 'ctx_settlements_order_unique',
    inv: 'INV-7 (CTX is paid at most once per order)',
  },
  {
    name: 'interest_mint_snapshots_user_asset_period_unique',
    inv: 'INV-9 sibling (one on-chain interest mint per user/asset/UTC-day, ADR 031/036 Phase D)',
  },
  {
    name: 'credit_transactions_interest_period_unique',
    inv: 'INV-9 sibling (legacy off-chain interest-accrual period idempotency)',
  },
];

const REQUIRED_CHECKS = [
  {
    name: 'user_credits_non_negative',
    inv: 'INV-1 (mirror never goes negative)',
    mustInclude: ['>= 0'],
  },
  {
    name: 'credit_transactions_amount_sign',
    inv: 'INV-1 (per-type sign pinned, so a credit/debit cannot flip)',
    mustInclude: ["'cashback'", "'spend'", '> 0', '< 0'],
  },
  {
    name: 'orders_state_known',
    inv: 'INV-6 (every paid order reaches a user-whole terminal state — state machine is closed)',
    mustInclude: [
      "'pending_payment'",
      "'paid'",
      "'procuring'",
      "'fulfilled'",
      "'failed'",
      "'expired'",
    ],
  },
  {
    name: 'pending_payouts_interest_mint_asset_pinned',
    inv: 'INV-10 (interest mints only for backed assets — GBPLOOP only)',
    mustInclude: ["'GBPLOOP'"],
  },
  {
    name: 'credit_transactions_reason_length',
    inv: 'money-adjacent (ADR-017 admin-write reason integrity — bounds a direct-INSERT bypass of the app-layer 2..500 char validator)',
  },
];

// ── 4. Resolve + assert ─────────────────────────────────────────────────

const violations = [];

function checkGroup(entries, creates, drops, kindLabel) {
  for (const entry of entries) {
    const resolved = resolve(entry.name, creates, drops);
    if (resolved === null) {
      violations.push(
        `MISSING ${kindLabel} "${entry.name}" (backs ${entry.inv}) — no CREATE event survives ` +
          `a last-write-wins replay of the migration chain. Either it was never added, or a ` +
          `later migration dropped it.`,
      );
      continue;
    }
    for (const needle of entry.mustInclude ?? []) {
      if (!resolved.body.includes(needle)) {
        violations.push(
          `WEAKENED ${kindLabel} "${entry.name}" (backs ${entry.inv}) — its surviving definition ` +
            `(from ${fileAt(resolved.pos)}) no longer contains the expected fragment ${JSON.stringify(needle)}. ` +
            `Definition captured:\n${resolved.body}`,
        );
      }
    }
  }
}

checkGroup(REQUIRED_FUNCTIONS, functionCreates, new Map(), 'function');
checkGroup(REQUIRED_TRIGGERS, triggerCreates, triggerDrops, 'trigger');
checkGroup(REQUIRED_INDEXES, indexCreates, indexDrops, 'unique index');
checkGroup(REQUIRED_CHECKS, constraintCreates, constraintDrops, 'CHECK constraint');

const totalTracked =
  REQUIRED_FUNCTIONS.length +
  REQUIRED_TRIGGERS.length +
  REQUIRED_INDEXES.length +
  REQUIRED_CHECKS.length;

if (violations.length > 0) {
  console.error(
    `check-money-invariants: FAIL — ${violations.length} of ${totalTracked} tracked money-critical ` +
      `DB object(s) are missing or weakened:\n\n` +
      violations.map((v) => `  ✗ ${v}`).join('\n\n') +
      `\n\nThis is the DB-layer presence gate for docs/invariants.md's "DB:" enforcement-tier rows ` +
      `(T0-3, docs/money-auth-worklist.md). If this is a deliberate, reviewed change to a money ` +
      `invariant, update the tracked list + \`mustInclude\` assertions in ` +
      `scripts/check-money-invariants.mjs AND docs/invariants.md in the same PR, with a money-review.`,
  );
  process.exit(1);
}

console.log(
  `check-money-invariants: OK — all ${totalTracked} tracked money-critical DB objects ` +
    `(${REQUIRED_FUNCTIONS.length} function, ${REQUIRED_TRIGGERS.length} trigger, ` +
    `${REQUIRED_INDEXES.length} unique index, ${REQUIRED_CHECKS.length} CHECK constraint) ` +
    `are present with their documented shape.`,
);
