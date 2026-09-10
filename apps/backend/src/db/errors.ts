// Shared unique-violation detection for the document store.
import { UniqueViolationError } from './store.js';

export { UniqueViolationError };

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof UniqueViolationError;
}
