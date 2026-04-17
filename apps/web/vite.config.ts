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
});
