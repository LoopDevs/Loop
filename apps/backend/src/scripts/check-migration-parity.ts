/**
 * Migration ↔ schema.ts parity gate.
 *
 * The repo uses HAND-WRITTEN SQL migrations (A2-412 / A2-703 — see
 * drizzle.config.ts): `drizzle-kit generate` is an emergency-only
 * escape hatch and the snapshot chain in `meta/` only carries the
 * 0000 baseline. That means nothing structurally guarantees that
 * `src/db/schema.ts` (what the ORM believes) and the migration chain
 * (what production actually runs) describe the same database. This
 * script closes that gap empirically:
 *
 *   1. Creates two scratch databases on the target server.
 *   2. DB A ("migrations"): replays the checked-in migration chain
 *      0000→latest through the same drizzle-orm migrator that
 *      `runMigrations()` uses at backend startup.
 *   3. DB B ("schema"): materialises `schema.ts` directly via
 *      drizzle-kit's programmatic `generateMigration(empty → schema)`
 *      SQL emission (the `drizzle-kit push --dry-run`-style
 *      expectation; `pushSchema` itself is unusable here — its
 *      introspection drops query parameters on composite-PK tables in
 *      drizzle-kit 0.31).
 *   4. Introspects both databases' catalogs (tables, columns,
 *      constraints via pg_get_constraintdef, indexes via pg_indexes,
 *      triggers, enums) into canonical line sets and diffs them.
 *
 * Lines present on one side only are parity violations — except for
 * the explicit allowlist in `scripts/migration-parity-allowlist.json`
 * (repo root), which carries the shapes drizzle's schema DSL cannot
 * represent (e.g. the ADR-011 audit trigger). Unused allowlist
 * entries fail the run so the list ratchets down, never up.
 *
 * Usage (CI: flywheel-integration job; local: any disposable server):
 *   DATABASE_URL=postgres://loop:loop@localhost:5433/loop_test \
 *     npm run check:migration-parity -w @loop/backend
 *
 * The DATABASE_URL database itself is only used as the maintenance
 * connection for CREATE/DROP DATABASE — its contents are untouched.
 */
/* eslint-disable no-console -- operator-facing CLI gate, same as check-ledger-invariant.ts */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from '../db/schema.js';

// schema.ts uses bigint("…", { mode: 'bigint' }) columns with BigInt
// defaults; drizzle-kit's snapshot differ JSON-serialises snapshots and
// BigInt has no default JSON representation.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
  return this.toString();
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(HERE, '../db/migrations');
const ALLOWLIST_PATH = path.resolve(HERE, '../../../../scripts/migration-parity-allowlist.json');

const MAINTENANCE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://loop:loop@localhost:5433/loop_test';

const DB_MIGRATIONS = 'loop_parity_migrations';
const DB_SCHEMA = 'loop_parity_schema';

/** Env escape hatch for an unusual CI whose disposable DB the heuristic below can't recognise. */
const ALLOW_DESTRUCTIVE_OVERRIDE = 'ALLOW_DESTRUCTIVE_MIGRATION_PARITY';

/**
 * BK-migparity: heuristic for "this DATABASE_URL points at a database we
 * must NOT run destructive DDL against." The script DROPs and CREATEs
 * `loop_parity_*` databases on the target server, so it may only ever
 * touch a disposable test server. A URL is production-looking (→ true,
 * refuse) unless it is unmistakably a throwaway target: a loopback host,
 * or a host/database name carrying an explicit test marker. Any
 * `prod`/`production` marker is always unsafe; an unparseable URL is
 * treated as unsafe (we can't prove it's a throwaway).
 */
export function isProdLookingDatabaseUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true;
  }
  // `URL.hostname` keeps the brackets on IPv6 literals (`[::1]`); strip
  // them so the loopback comparison below matches.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).toLowerCase();
  const haystack = `${host} ${dbName}`;
  if (haystack.includes('prod')) return true;
  const isLoopback =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
  const TEST_MARKERS = ['test', 'scratch', 'ephemeral', 'parity', 'sandbox'];
  const hasTestMarker = TEST_MARKERS.some((marker) => haystack.includes(marker));
  return !(isLoopback || hasTestMarker);
}

/**
 * Throws unless `url` is a safe destructive target (or the operator has
 * explicitly opted out via `ALLOW_DESTRUCTIVE_MIGRATION_PARITY=1`).
 */
export function assertEphemeralParityTarget(url: string): void {
  if (process.env[ALLOW_DESTRUCTIVE_OVERRIDE] === '1') return;
  if (isProdLookingDatabaseUrl(url)) {
    throw new Error(
      `check-migration-parity: refusing to DROP/CREATE databases on ${url} — it does not look ` +
        `like a disposable test server (no loopback host or test marker, or it carries a ` +
        `production marker). Point DATABASE_URL at a throwaway server (e.g. ` +
        `postgres://loop:loop@localhost:5433/loop_test), or set ${ALLOW_DESTRUCTIVE_OVERRIDE}=1 ` +
        `to override for an unusual CI target.`,
    );
  }
}

interface AllowlistEntry {
  /** 'migrations-only' | 'schema-only' */
  side: string;
  /** Exact canonical line the diff is allowed to contain. */
  line: string;
  reason: string;
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/**
 * Canonical, order-independent description of a database's public
 * schema. Every entry is a single line keyed by object kind so the
 * diff output reads naturally.
 */
async function introspect(url: string): Promise<Set<string>> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const lines = new Set<string>();
  try {
    const columns = await sql<
      {
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
        character_maximum_length: number | null;
        numeric_precision: number | null;
        numeric_scale: number | null;
      }[]
    >`
      SELECT c.table_name, c.column_name, c.data_type, c.is_nullable,
             c.column_default, c.character_maximum_length,
             c.numeric_precision, c.numeric_scale
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    `;
    for (const c of columns) {
      const type =
        c.data_type === 'character'
          ? `character(${c.character_maximum_length})`
          : c.data_type === 'character varying' && c.character_maximum_length !== null
            ? `varchar(${c.character_maximum_length})`
            : c.data_type === 'numeric' && c.numeric_precision !== null
              ? `numeric(${c.numeric_precision},${c.numeric_scale})`
              : c.data_type;
      lines.add(
        `column ${c.table_name}.${c.column_name}: ${type} ` +
          `${c.is_nullable === 'YES' ? 'null' : 'not-null'} default=${c.column_default ?? '∅'}`,
      );
    }

    // pg_get_constraintdef renders both hand-written and generated
    // constraint expressions through the same deparser, so equivalent
    // constraints compare equal regardless of source formatting.
    const constraints = await sql<{ table_name: string; conname: string; def: string }[]>`
      SELECT rel.relname AS table_name, con.conname,
             pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE nsp.nspname = 'public'
    `;
    for (const c of constraints) {
      lines.add(`constraint ${c.table_name}.${c.conname}: ${c.def}`);
    }

    const indexes = await sql<{ tablename: string; indexname: string; indexdef: string }[]>`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes WHERE schemaname = 'public'
    `;
    for (const i of indexes) {
      lines.add(`index ${i.tablename}.${i.indexname}: ${i.indexdef}`);
    }

    const triggers = await sql<{ table_name: string; tgname: string; def: string }[]>`
      SELECT rel.relname AS table_name, tg.tgname, pg_get_triggerdef(tg.oid) AS def
      FROM pg_trigger tg
      JOIN pg_class rel ON rel.oid = tg.tgrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE nsp.nspname = 'public' AND NOT tg.tgisinternal
    `;
    for (const t of triggers) {
      lines.add(`trigger ${t.table_name}.${t.tgname}: ${t.def}`);
    }

    const enums = await sql<{ typname: string; labels: string[] }[]>`
      SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace nsp ON nsp.oid = t.typnamespace
      WHERE nsp.nspname = 'public'
      GROUP BY t.typname
    `;
    for (const e of enums) {
      lines.add(`enum ${e.typname}: ${e.labels.join(',')}`);
    }
  } finally {
    await sql.end();
  }
  return lines;
}

async function main(): Promise<void> {
  // BK-migparity: fail before opening any connection if the target
  // doesn't look like a throwaway server — the very next thing this
  // function does is DROP/CREATE databases on it.
  assertEphemeralParityTarget(MAINTENANCE_URL);

  const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as AllowlistEntry[];

  const maintenance = postgres(MAINTENANCE_URL, { max: 1, onnotice: () => {} });
  try {
    for (const db of [DB_MIGRATIONS, DB_SCHEMA]) {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS ${db}`);
      await maintenance.unsafe(`CREATE DATABASE ${db}`);
    }
  } finally {
    await maintenance.end();
  }

  // ── DB A: replay the checked-in migration chain ──────────────────────
  // Same migrator + folder as `runMigrations()` in src/db/client.ts —
  // this IS the production startup path, pointed at a scratch DB.
  const migUrl = withDatabase(MAINTENANCE_URL, DB_MIGRATIONS);
  const migClient = postgres(migUrl, { max: 1, onnotice: () => {} });
  try {
    console.log(`[parity] replaying migration chain into ${DB_MIGRATIONS}…`);
    await migrate(drizzle(migClient), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await migClient.end();
  }

  // ── DB B: materialise schema.ts directly ─────────────────────────────
  const schemaUrl = withDatabase(MAINTENANCE_URL, DB_SCHEMA);
  const schemaClient = postgres(schemaUrl, { max: 1, onnotice: () => {} });
  try {
    console.log(`[parity] materialising schema.ts into ${DB_SCHEMA}…`);
    const statements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson(schema),
    );
    for (const statement of statements) {
      await schemaClient.unsafe(statement);
    }
  } finally {
    await schemaClient.end();
  }

  // ── Diff ──────────────────────────────────────────────────────────────
  console.log('[parity] introspecting both databases…');
  const fromMigrations = await introspect(migUrl);
  const fromSchema = await introspect(schemaUrl);

  const migrationsOnly = [...fromMigrations].filter((l) => !fromSchema.has(l)).sort();
  const schemaOnly = [...fromSchema].filter((l) => !fromMigrations.has(l)).sort();

  const usedAllowlist = new Set<AllowlistEntry>();
  const isAllowed = (side: string, line: string): boolean => {
    const hit = allowlist.find((e) => e.side === side && e.line === line);
    if (hit !== undefined) {
      usedAllowlist.add(hit);
      return true;
    }
    return false;
  };

  const violations: string[] = [];
  for (const line of migrationsOnly) {
    if (!isAllowed('migrations-only', line)) {
      violations.push(`in migrations but not schema.ts: ${line}`);
    }
  }
  for (const line of schemaOnly) {
    if (!isAllowed('schema-only', line)) {
      violations.push(`in schema.ts but not migrations: ${line}`);
    }
  }
  // Ratchet: stale allowlist entries must be deleted, not hoarded.
  for (const entry of allowlist) {
    if (!usedAllowlist.has(entry)) {
      violations.push(
        `stale allowlist entry (no longer differs — remove it): [${entry.side}] ${entry.line}`,
      );
    }
  }

  if (violations.length > 0) {
    console.error(`\n[parity] FAIL — ${violations.length} violation(s):\n`);
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(
      '\nEither fix the drift (migration or schema.ts) or — only for shapes the\n' +
        'drizzle schema DSL cannot represent — add an entry with a reason to\n' +
        'scripts/migration-parity-allowlist.json.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[parity] OK — ${fromMigrations.size} catalog entries match` +
      (allowlist.length > 0 ? ` (${allowlist.length} allowlisted divergences)` : ''),
  );
}

// Only run the CLI when this module is the process entry point. Importing
// it — e.g. the unit test that exercises the DATABASE_URL guard directly —
// must NOT run `main()`, connect, or issue DDL. Mirrors quarterly-tax.ts.
const isEntrypoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  await main();
}
