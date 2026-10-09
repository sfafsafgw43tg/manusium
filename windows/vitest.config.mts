import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@octo/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@octo/shell': path.resolve(__dirname, 'packages/shell/src'),
    },
  },
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
