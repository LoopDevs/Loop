/**
 * Deploy-environment values (API origin, env tag, phase gate) resolved at
 * RUNTIME instead of baked by Vite, so one web image serves every
 * environment (the spend-admin `FE_API_ENDPOINT` pattern).
 *
 * Resolution order:
 *  - server (SSR): `process.env` — `API_URL` / `LOOP_ENV` / `PHASE_1_ONLY`
 *    first (set via k8s pod env), then their legacy `VITE_`-prefixed
 *    runtime spellings, then the values Vite baked into the bundle.
 *  - browser: `window.__ENV__` (stamped by the root Layout's inline
 *    script from the SSR snapshot), then baked values.
 *
 * The Capacitor static export has no server at runtime — there
 * `window.__ENV__` is whatever the build machine's env produced, i.e.
 * exactly the old build-time behavior. Build args therefore remain the
 * native path's configuration surface.
 */

export interface RuntimeEnv {
  API_URL?: string | undefined;
  LOOP_ENV?: string | undefined;
  PHASE_1_ONLY?: string | undefined;
}

declare global {
  interface Window {
    __ENV__?: RuntimeEnv;
  }
}

// Read lazily with bracket access so tests can stub `import.meta.env`
// after module load (matches the pre-existing defaultPhase1Only contract).
function bakedEnv(): RuntimeEnv {
  return {
    API_URL: import.meta.env['VITE_API_URL'] as string | undefined,
    LOOP_ENV: import.meta.env['VITE_LOOP_ENV'] as string | undefined,
    PHASE_1_ONLY: import.meta.env['VITE_PHASE_1_ONLY'] as string | undefined,
  };
}

function fromProcessEnv(name: keyof RuntimeEnv): string | undefined {
  if (typeof process === 'undefined' || process.env === undefined) return undefined;
  return process.env[name] ?? process.env[`VITE_${name}`];
}

/** The current environment's values; safe to call on server and client. */
export function runtimeEnv(): RuntimeEnv {
  const baked = bakedEnv();
  if (typeof window !== 'undefined') {
    return { ...baked, ...window.__ENV__ };
  }
  return {
    API_URL: fromProcessEnv('API_URL') ?? baked.API_URL,
    LOOP_ENV: fromProcessEnv('LOOP_ENV') ?? baked.LOOP_ENV,
    PHASE_1_ONLY: fromProcessEnv('PHASE_1_ONLY') ?? baked.PHASE_1_ONLY,
  };
}

/**
 * Inline-script payload stamping the SSR-resolved env onto
 * `window.__ENV__` before any module executes. `<` is escaped so a
 * value can never close the script element (XSS via config).
 */
export function runtimeEnvScript(): string {
  const snapshot: RuntimeEnv = {};
  const env = runtimeEnv();
  if (env.API_URL !== undefined) snapshot.API_URL = env.API_URL;
  if (env.LOOP_ENV !== undefined) snapshot.LOOP_ENV = env.LOOP_ENV;
  if (env.PHASE_1_ONLY !== undefined) snapshot.PHASE_1_ONLY = env.PHASE_1_ONLY;
  return `window.__ENV__=${JSON.stringify(snapshot).replace(/</g, '\\u003c')};`;
}
