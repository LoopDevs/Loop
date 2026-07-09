/**
 * Shared config for the Loop k6 load-test suite (tools/load-test/).
 *
 * Both scenario scripts (browse.js, auth-order.js) import from here so the
 * target URL and the "don't error more than 1%" budget stay defined once.
 * See docs/load-testing.md for how these scripts are run (locally via
 * run-local.sh, or via .github/workflows/load-test.yml) and what the
 * thresholds mean.
 *
 * BASE_URL defaults to the mocked-e2e backend port (8081) — see
 * playwright.mocked.config.ts, which is what `run-local.sh` boots. Override
 * with k6's `-e BASE_URL=...` flag or the `BASE_URL` env var (run-local.sh
 * sets this for you on macOS, where a k6-in-Docker run needs
 * `host.docker.internal` instead of `localhost` to reach the host-run
 * backend — see run-local.sh's networking comment).
 */
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8081';

/**
 * Every scenario fails the run if more than 1% of requests error — this is
 * the shared error-rate budget layered on top of each script's own
 * SLO-derived latency threshold (docs/slo.md). `http_req_failed` is k6's
 * built-in (any non-2xx/3xx or network error); `errors` is our own Rate
 * metric, incremented explicitly on failed `check()`s so a 200 with an
 * unexpected body (e.g. missing `accessToken`) also counts.
 */
export const COMMON_THRESHOLDS = {
  http_req_failed: ['rate<0.01'],
  errors: ['rate<0.01'],
};

/** JSON POST headers, with room for a caller to add e.g. Authorization. */
export function jsonHeaders(extra) {
  return Object.assign({ 'Content-Type': 'application/json' }, extra || {});
}

/**
 * Scales a ramping-vus `stages` array's `target` VU counts by
 * `__ENV.VUS_SCALE` (default 1 — i.e. the stage targets as written).
 * `.github/workflows/load-test.yml`'s `vu_scale_factor` dispatch input maps
 * straight to this — e.g. 0.25 to run a lighter smoke pass on a shared CI
 * runner, or >1 to push past the numbers recorded in docs/load-testing.md.
 * Invalid/non-positive values fall back to 1 rather than producing a
 * zero-VU (silently-passing) run.
 */
export function scaleStages(stages) {
  const raw = Number(__ENV.VUS_SCALE);
  const scale = Number.isFinite(raw) && raw > 0 ? raw : 1;
  return stages.map((stage) => ({
    ...stage,
    target: Math.max(0, Math.round(stage.target * scale)),
  }));
}
