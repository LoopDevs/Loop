/**
 * Minimal dotted-numeric version comparison for the P2-14 force-update
 * gate. The client version comes from `package.json` via
 * `VITE_CLIENT_VERSION` (see `apps/web/vite.config.ts`) and the floor
 * from `/api/config` `minSupportedVersion` — both are plain
 * `major.minor.patch` strings, so a full semver dependency would be
 * dead weight. Pre-release / build suffixes (`-beta.1`, `+sha`) are
 * ignored: the numeric core is what gates.
 */

/**
 * Parses "1.2.3" (or "1.2.3-beta+sha") into `[1, 2, 3]`. Returns `[]`
 * for anything without a clean numeric-dotted core (empty, or a segment
 * that isn't all digits) so the caller can fail OPEN on garbage rather
 * than coercing "not-a-version" into `[0]` and treating it as older.
 */
function parseVersion(version: string): number[] {
  // Drop any pre-release (`-…`) or build (`+…`) metadata; keep the core.
  const core = version.trim().split(/[-+]/)[0] ?? '';
  if (core === '') return [];
  const segments = core.split('.');
  const parsed: number[] = [];
  for (const segment of segments) {
    if (!/^\d+$/.test(segment)) return [];
    parsed.push(Number.parseInt(segment, 10));
  }
  return parsed;
}

/**
 * Returns -1 if `a < b`, 0 if equal, 1 if `a > b`, comparing
 * segment-by-segment (so `1.10.0 > 1.9.0`, unlike a string compare).
 * Missing trailing segments are treated as 0 (`1.2` === `1.2.0`).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

/**
 * True when `current` is older than `minimum` and should be blocked.
 *
 * Fails OPEN — returns false — when `minimum` is null/blank (no gate
 * configured) or either version has no parseable numeric core. A
 * force-update gate must never lock a user out of a working build on a
 * malformed or absent floor; an over-eager block is worse than a missed
 * one for a control whose whole job is to be a last resort.
 */
export function isOutdated(current: string, minimum: string | null | undefined): boolean {
  if (minimum === null || minimum === undefined || minimum.trim() === '') return false;
  if (parseVersion(current).length === 0 || parseVersion(minimum).length === 0) return false;
  return compareVersions(current, minimum) < 0;
}
