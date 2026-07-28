import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

/*
 * The `ui` vitest project. Merged onto ui's own vite config so the react plugin
 * and the `@shared` alias come along for free.
 *
 * `vitest` is deliberately NOT a dependency of ui/package.json — resolution
 * walks up to the root vitest, and a second copy risks two runtimes in one run.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      name: 'ui',
      // No DOM: AC1 renders through react-dom/server's renderToStaticMarkup,
      // and everything else reads files off a real `vite build`.
      environment: 'node',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      // buildUi() shells out to a real Vite build (~2s); the default 5s timeout
      // is too tight on a cold start.
      testTimeout: 30_000,
    },
  }),
);
