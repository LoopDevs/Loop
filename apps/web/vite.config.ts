import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

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
