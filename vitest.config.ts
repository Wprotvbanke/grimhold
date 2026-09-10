import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@grimhold/shared': new URL('./packages/shared/src/index.ts', import.meta.url).pathname,
    },
  },
});
