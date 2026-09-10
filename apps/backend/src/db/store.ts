// document-store abstraction — memory + mongo drivers
import type { CollectionDocs, CollectionName } from './types.js';

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
      $options?: string;
      /**
       * Build with `containsFilter()` — unescaped operator input is a wrong match and ReDoS surface.
       */
      $regex?: string;
    };

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
  insertOne(doc: T): Promise<void>;
  /**
   * CAS primitive: put the "still live" predicate in the filter; `null` result means another caller won.
   */
  updateOne(filter: Filter<T>, update: Update<T>, options?: FindOptions<T>): Promise<T | null>;
  updateMany(filter: Filter<T>, update: Update<T>): Promise<number>;
  replaceOne(filter: Filter<T>, doc: T, options?: { upsert?: boolean }): Promise<void>;
  deleteMany(filter: Filter<T>): Promise<number>;
}

export interface DataStore {
  collection<Name extends CollectionName>(name: Name): Collection<CollectionDocs[Name]>;
  init(): Promise<void>;
  close(): Promise<void>;
}

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

export function escapeRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Case-insensitive literal substring match. Escaped to prevent ReDoS and wrong matches.
 * Collection scan on both drivers; fine for low-frequency admin surfaces.
 */
export function containsFilter(term: string): { $regex: string; $options: string } {
  return { $regex: escapeRegex(term), $options: 'i' };
}
