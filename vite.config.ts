import { defineConfig } from 'vite';

// The artwork is served locally only; relative base keeps a static build portable.
export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
