/**
 * Shared unique-violation detection for the document store.
 *
 * Both drivers surface a unique-spec collision as `UniqueViolationError`
 * (the Mongo driver translates the server's E11000 into it), so callers
 * that treat "already inserted" as a benign race — order idempotency,
 * the social id-token replay guard — check one error shape regardless
 * of driver.
 */
import { UniqueViolationError } from './store.js';

export { UniqueViolationError };

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof UniqueViolationError;
}
