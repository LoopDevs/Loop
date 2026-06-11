import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

// A2-1529: expose the package.json version as VITE_CLIENT_VERSION so
// api-client.ts can stamp every outbound request with X-Client-Version.
// Prefer the env override (CI can set a build number) when set, otherwise
// fall back to package.json at build time — either path resolves before
// the bundle is compiled.
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(pathResolve(__dirname, './package.json'), 'utf8')) as {
  version?: string;
};
const clientVersion = process.env['VITE_CLIENT_VERSION'] ?? pkg.version ?? '0.0.0';

// Vite 8 supports tsconfig paths resolution natively via resolve.tsconfigPaths,
// so we no longer need the vite-tsconfig-paths plugin. Vite was printing a
// deprecation warning for it on every build; this removes both the warning
// and one dependency.
export default defineConfig(({ command, mode }) => {
  // Resolve VITE_API_URL from the shell env first (CI / Playwright set
  // it explicitly), then from .env / .env.local via loadEnv — vite only
  // injects those into `import.meta.env`, not `process.env`, so config
  // code has to load them itself.
  const fileEnv = loadEnv(mode, __dirname, 'VITE_');
  const apiUrl = process.env['VITE_API_URL'] ?? fileEnv['VITE_API_URL'];

  // Dev server only: refuse to boot without an explicit API target.
  // The previous behaviour silently fell back to the production API
  // (https://api.loopfinance.io), so a developer without .env.local
  // would unknowingly point their local app — auth flows included —
  // at production data (comprehensive-audit 2026-06-11, P10).
  if (command === 'serve' && (apiUrl === undefined || apiUrl.length === 0)) {
    throw new Error(
      'VITE_API_URL is not set. Create apps/web/.env.local with\n' +
        '  VITE_API_URL=http://localhost:8080\n' +
        '(see docs/development.md) so the dev server proxies /api to your ' +
        'local backend instead of silently targeting production.',
    );
  }

  return {
    plugins: [tailwindcss(), reactRouter()],
    resolve: {
      tsconfigPaths: true,
    },
    optimizeDeps: {
      exclude: ['@bufbuild/protobuf'],
    },
    define: {
      'import.meta.env.VITE_CLIENT_VERSION': JSON.stringify(clientVersion),
    },
    // Dev-only proxy so the browser talks to the same origin (localhost)
    // and doesn't trip production CORS on the hosted API, which only
    // allows-lists loopfinance.io + Capacitor native origins. Only used
    // when VITE_API_URL is an absolute http(s) URL — if the local
    // backend is running, `API_BASE` points at localhost directly and
    // this proxy is skipped.
    server: {
      proxy: {
        '/api': {
          // The fallback is unreachable in dev (the throw above fires
          // first); it only keeps the type happy for `vite build`,
          // which never starts the proxy.
          target: apiUrl ?? 'http://localhost:8080',
          changeOrigin: true,
          secure: true,
        },
      },
    },
  };
});
