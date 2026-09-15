import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          // The second-slot load flake (dev-server, phantom-utilities, open,
          // seal by name) is the 5s default overrunning under full-suite load.
          testTimeout: 15_000,
        },
      },
      './ui/vitest.config.ts',
    ],
    coverage: {
      reportsDirectory: 'coverage',
    },
  },
});
