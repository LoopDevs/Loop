/**
 * A2-1165 (slice 27): admin CSV download helper extracted from
 * `services/admin.ts`. Not an endpoint — a browser-side utility
 * shared by every CSV-export button on the admin panel:
 *
 * - `downloadAdminCsv(path, filename)` — fetches the path with
 *   the bearer token in binary mode, then synthesises a click
 *   on a temporary anchor with a Blob URL. Works around the
 *   fact that a plain `<a href>` can't attach the
 *   `Authorization` header that admin CSV endpoints require.
 *   The Blob URL is revoked in `finally` because Firefox leaks
 *   memory without it and Chromium's GC is slow enough that
 *   rapid downloads stack up.
 *
 * `services/admin.ts` keeps a barrel re-export so existing
 * consumers (every CSV-export button: `routes/admin.cashback.tsx`,
 * `routes/admin.payouts.tsx`, `routes/admin.users.tsx`, etc.)
 * don't have to re-target imports.
 */
import { authenticatedRequest } from './api-client';

/**
 * Fetch a CSV admin endpoint with the bearer token attached, then
 * synthesise a download by clicking a temporary anchor with a Blob
 * URL. Fully browser-only; throws via `ApiException` on auth /
 * network / status failures.
 */
export async function downloadAdminCsv(path: string, filename: string): Promise<void> {
  const buf = await authenticatedRequest<ArrayBuffer>(path, { binary: true });
  const blob = new Blob([buf], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
