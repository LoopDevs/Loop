/**
 * The document-store abstraction every repository module talks to.
 *
 * Two drivers implement it:
 *   - `memory-store.ts` — the whole database lives in process memory,
 *     hydrated from (and flushed back to) a single JSON file. The
 *     default for dev/test and the current undeployed posture.
 *   - `mongo-store.ts` — MongoDB via the official driver.
 *
 * The filter/update language is a deliberately tiny Mongo subset
 * (equality + `$lt/$lte/$gt/$gte/$ne/$in`, updates via `$set/$inc`) so
 * the memory driver can implement it in a few dozen lines and the
 * Mongo driver can pass it through untouched.
 */
import type { CollectionDocs, CollectionName } from './types.js';

/** Field predicate: a bare value means equality (null matches null/missing). */
export type FieldFilter<V> =
  | V
  | null
  | {
      $lt?: V;
      $lte?: V;
      $gt?: V;
      $gte?: V;
      $ne?: V | null;
      $in?: ReadonlyArray<V | null>;
      /**
       * Case-insensitivity and other flags for `$regex`. Mongo reads
       * this natively; the memory driver passes it to `RegExp`.
       */
      $options?: string;
      /**
       * Substring / pattern match on a string field, in Mongo's own
       * spelling so the filter still passes straight through to the
       * driver. Build it with `containsFilter()` rather than by hand —
       * an unescaped operator-supplied term would be both a wrong
       * match (`a.b` matching `axb`) and a ReDoS surface.
       */
      $regex?: string;
    };

/** Implicit AND across fields. */
export type Filter<T> = {
  [K in keyof T]?: FieldFilter<NonNullable<T[K]>>;
};

export type Update<T> = {
  $set?: Partial<T>;
  $inc?: { [K in keyof T]?: number };
};

export type SortDirection = 'asc' | 'desc';
export type Sort<T> = ReadonlyArray<readonly [keyof T & string, SortDirection]>;

export interface FindOptions<T> {
  sort?: Sort<T>;
  limit?: number;
  skip?: number;
}

/** Thrown by `insertOne` when a `COLLECTION_SPECS` unique tuple is violated. */
export class UniqueViolationError extends Error {
  constructor(
    public readonly collection: string,
    public readonly fields: readonly string[],
  ) {
    super(`unique violation on ${collection} (${fields.join(', ')})`);
    this.name = 'UniqueViolationError';
  }
}

export interface Collection<T extends object> {
  findOne(filter: Filter<T>, options?: FindOptions<T>): Promise<T | null>;
  findMany(filter?: Filter<T>, options?: FindOptions<T>): Promise<T[]>;
  count(filter?: Filter<T>): Promise<number>;
  /** Inserts a fully-formed doc. Throws `UniqueViolationError` on a unique-spec collision. */
  insertOne(doc: T): Promise<void>;
  /**
   * Atomically updates the first doc matching `filter` (respecting
   * `options.sort`) and returns the updated doc, or `null` when nothing
   * matched. This is the CAS primitive: put the "still live" predicate
   * in the filter and a `null` result means another caller won.
   */
  updateOne(filter: Filter<T>, update: Update<T>, options?: FindOptions<T>): Promise<T | null>;
  updateMany(filter: Filter<T>, update: Update<T>): Promise<number>;
  /** Replace-by-filter; with `upsert` inserts when nothing matches. */
  replaceOne(filter: Filter<T>, doc: T, options?: { upsert?: boolean }): Promise<void>;
  deleteMany(filter: Filter<T>): Promise<number>;
}

export interface DataStore {
  collection<Name extends CollectionName>(name: Name): Collection<CollectionDocs[Name]>;
  /** Connect / hydrate. Must be called (and awaited) before any collection use. */
  init(): Promise<void>;
  /** Flush + disconnect. Safe to call more than once. */
  close(): Promise<void>;
}

// ─── Shared matcher / update helpers (used by the memory driver) ────────────

function isOperatorObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !(v instanceof Date) &&
    !Array.isArray(v) &&
    Object.keys(v).some((k) => k.startsWith('$'))
  );
}

function compareValues(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return 0;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  // Missing fields and explicit nulls are the same thing to a filter.
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return a === b;
}

export function matchesFilter<T extends object>(doc: T, filter: Filter<T> | undefined): boolean {
  if (filter === undefined) return true;
  for (const [key, predicate] of Object.entries(filter)) {
    if (predicate === undefined) continue;
    const value = (doc as Record<string, unknown>)[key];
    if (!isOperatorObject(predicate)) {
      if (!valuesEqual(value, predicate)) return false;
      continue;
    }
    const ops = predicate;
    // Range operators never match null/missing values (SQL comparison semantics).
    const missing = value === null || value === undefined;
    if (ops['$lt'] !== undefined && (missing || compareValues(value, ops['$lt']) >= 0))
      return false;
    if (ops['$lte'] !== undefined && (missing || compareValues(value, ops['$lte']) > 0))
      return false;
    if (ops['$gt'] !== undefined && (missing || compareValues(value, ops['$gt']) <= 0))
      return false;
    if (ops['$gte'] !== undefined && (missing || compareValues(value, ops['$gte']) < 0))
      return false;
    if ('$ne' in ops && valuesEqual(value, ops['$ne'])) return false;
    if (ops['$in'] !== undefined) {
      const list = ops['$in'] as ReadonlyArray<unknown>;
      if (!list.some((candidate) => valuesEqual(value, candidate))) return false;
    }
    if (ops['$regex'] !== undefined) {
      // Only strings can match a pattern; null/missing/non-string
      // never does, mirroring Mongo.
      if (typeof value !== 'string') return false;
      const flags = typeof ops['$options'] === 'string' ? ops['$options'] : '';
      if (!new RegExp(ops['$regex'] as string, flags).test(value)) return false;
    }
  }
  return true;
}

export function applyUpdate<T extends object>(doc: T, update: Update<T>): T {
  const next = { ...doc } as Record<string, unknown>;
  if (update.$set !== undefined) {
    for (const [key, value] of Object.entries(update.$set)) {
      if (value !== undefined) next[key] = value;
    }
  }
  if (update.$inc !== undefined) {
    for (const [key, delta] of Object.entries(update.$inc)) {
      if (typeof delta !== 'number') continue;
      const current = next[key];
      next[key] = (typeof current === 'number' ? current : 0) + delta;
    }
  }
  return next as T;
}

export function sortDocs<T extends object>(docs: T[], sort: Sort<T> | undefined): T[] {
  if (sort === undefined || sort.length === 0) return docs;
  return [...docs].sort((a, b) => {
    for (const [field, direction] of sort) {
      const cmp = compareValues(
        (a as Record<string, unknown>)[field],
        (b as Record<string, unknown>)[field],
      );
      if (cmp !== 0) return direction === 'asc' ? cmp : -cmp;
    }
    return 0;
  });
}

/**
 * Escapes every regex metacharacter so a term is matched literally.
 * Exported for tests; handlers should reach for `containsFilter`.
 */
export function escapeRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Case-insensitive "field contains this literal text" predicate — the
 * document-store stand-in for SQL `ILIKE '%term%'`.
 *
 * The term is escaped, so an operator searching for `a.b` matches the
 * literal `a.b` rather than `axb`, and no operator-supplied input can
 * reach the regex engine as syntax (a pathological pattern would be a
 * ReDoS on the memory driver and a scan amplifier on Mongo).
 *
 * This is a collection scan on both drivers. That is fine for the
 * admin surfaces that use it — operator-facing, low-frequency, and
 * bounded by an explicit row cap — and would want an index (or a
 * proper text search) before it went anywhere near a hot path.
 */
export function containsFilter(term: string): { $regex: string; $options: string } {
  return { $regex: escapeRegex(term), $options: 'i' };
}
