/** Encodes a merchant name to its URL slug. Matches backend `merchantSlug()`. */
export function toSlug(name: string): string {
  return encodeURIComponent(name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''));
}
