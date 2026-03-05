/**
 * Converts a merchant name to a URL-safe slug.
 * Used by both backend (slug index) and web (link generation).
 *
 * IMPORTANT: This is the single source of truth for slug generation.
 * If this logic changes, the backend merchant slug index and all
 * frontend links will use the new format automatically.
 */
export function merchantSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}
