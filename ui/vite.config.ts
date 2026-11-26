import { defineConfig } from 'vite';

// The built client is served by the local binary from the same origin, so asset
// URLs stay relative and no dev proxy is needed once installed.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8794', ws: true },
    },
  },
});
