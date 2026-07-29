import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Kept in lockstep with ui/tsconfig.json `paths`: tsc reads that, the
    // bundler reads this, and configuring only one fails invisibly until the
    // other tool runs.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../src/shared', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    // Never base64-inline a font. Inlining would defeat no-egress.test.ts's
    // "the .woff2 files are actually bundled" check — the only automated signal
    // that the fonts didn't silently fall back — and bloat the CSS by a third.
    assetsInlineLimit: (filePath: string) => (filePath.endsWith('.woff2') ? false : undefined),
  },
});
