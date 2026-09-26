import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10000,
  },
});
