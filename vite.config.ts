import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: {
    // Relative to `root`, so this is web/dist.
    outDir: 'dist',
    emptyOutDir: true,
  },
});
