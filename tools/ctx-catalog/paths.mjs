/**
 * Durable vs cache paths for the catalog tooling (media v2 plan M1).
 *
 * The pipeline used to hardcode `/tmp/*.json`, which is wiped on reboot — that's
 * how hours of sourcing + approval work were nearly lost. Now:
 *
 *  - `dataPath(name)` → the git-tracked working set (`tools/ctx-catalog/data/`,
 *    override via `CTX_DATA_DIR`). Source of truth: sourced manifests, review
 *    decisions, plans. Survives reboot + machine loss; carries review history.
 *  - `cachePath(name)` → throwaway cache (`/tmp`, override via `CTX_CACHE_DIR`).
 *    Regenerable: the review image-proxy cache, scratch pulls.
 *
 * Scripts should read/write DURABLE state via `dataPath` and ephemeral scratch
 * via `cachePath`. Set `CTX_DATA_DIR=/tmp` to reproduce the old behaviour for a
 * throwaway run.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.CTX_DATA_DIR || resolve(here, 'data');
export const CACHE_DIR = process.env.CTX_CACHE_DIR || '/tmp';

export const dataPath = (name) => resolve(DATA_DIR, name);
export const cachePath = (name) => resolve(CACHE_DIR, name);

/**
 * Re-inject the logo.dev key into a URL whose token was scrubbed to
 * `LOGODEV_KEY_REDACTED` when the working set was committed to git (see
 * data/README.md). No-op if the URL isn't redacted or `LOGODEV_KEY` is unset.
 */
export const withLogodevKey = (url) =>
  typeof url === 'string' && url.includes('LOGODEV_KEY_REDACTED') && process.env.LOGODEV_KEY
    ? url.replaceAll('LOGODEV_KEY_REDACTED', process.env.LOGODEV_KEY)
    : url;
