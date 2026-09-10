import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: true,
  },
  resolve: {
    alias: {
      '@grimhold/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
});
