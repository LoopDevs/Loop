/**
 * Playwright globalSetup. The backend runs on the ephemeral in-memory
 * document store under NODE_ENV=test (no external database), so each
 * Playwright invocation's freshly-booted backend already starts from
 * an empty state — there is nothing to migrate or truncate any more.
 */
export default async function globalSetup(): Promise<void> {
  // Intentionally empty — see the header comment.
}
