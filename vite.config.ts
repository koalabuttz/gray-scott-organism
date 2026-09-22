import { defineConfig } from 'vite';

// The artwork is served locally only; relative base keeps a static build portable.
//
// **Test-server HMR suppression (Phase 4, round A flake fix).** `tests/support/browser.ts` opens the
// page once per test and then drives it for many seconds. While the suite runs, this repository is a
// working tree: an editor, a formatter or another agent routinely writes a source file. Because no
// module in the graph declares `import.meta.hot.accept`, Vite answers *any* such write with a full
// page reload sent to every connected client. A reload mid-test destroys the JS execution context
// (Playwright surfaces it as "Execution context was destroyed / navigation") and silently reverts
// live state to the startup defaults (an unpinned material, a fresh clock) — the two observed
// browser flake signatures. The Playwright `webServer` therefore starts Vite with `VITE_TEST=1`,
// which turns HMR (and its reload channel) off for the test server only; `npm run dev` is unchanged.
const testServer = process.env.VITE_TEST === '1';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
    ...(testServer ? { hmr: false } : {}),
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
