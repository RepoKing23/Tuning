import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base '' keeps asset URLs relative so the built app works from GitHub Pages,
// a subdirectory, or straight off the filesystem.
export default defineConfig({
  plugins: [react()],
  base: '',
  build: { target: 'es2020', chunkSizeWarningLimit: 1200 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
