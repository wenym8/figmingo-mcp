import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/acceptance/**/*.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
