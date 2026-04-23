import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
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
export default defineConfig({
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
        target:
          process.env['VITE_API_URL'] !== undefined && process.env['VITE_API_URL'].length > 0
            ? process.env['VITE_API_URL']
            : 'https://api.loopfinance.io',
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
