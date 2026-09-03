import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      './ui/vitest.config.ts',
    ],
    coverage: {
      reportsDirectory: 'coverage',
    },
  },
});
