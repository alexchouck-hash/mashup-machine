import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The CC0 drum kit ships as FLAC. Vite has no built-in handling for it, and
  // without this the glob in sampleKit.ts resolves to nothing and every voice
  // silently falls back to synthesis — a failure that makes no noise at all.
  assetsInclude: ['**/*.flac'],
  server: { port: 5173 },
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
