import { defineConfig } from '@playwright/test';

/**
 * Dedicated config for the AC.14 two-hour real-time acceptance soak (`tests/browser/soak2h.spec.ts`).
 *
 * It is deliberately separate from `playwright.config.ts`:
 *
 * - It **never writes `artifacts/playwright-report.json`** — that file is the recorded green-suite
 *   evidence, and a multi-hour soak run must not clobber it.
 * - It pins the **presentation** viewport (1920×1080, §11.1's measured target canvas) rather than the
 *   suite's 1280×720, and launches with the anti-throttling/audio flags a two-hour unattended run needs.
 * - `testMatch` narrows the run to the soak spec only.
 *
 * The anti-throttling flags matter for the tab-throttling hazard: even new-headless Chromium can
 * throttle `requestAnimationFrame` on a backgrounded/occluded renderer, which would collapse the
 * delivered-step rate. `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`
 * and `--disable-background-timer-throttling` (plus disabling `CalculateNativeWinOcclusion` and
 * `IntensiveWakeUpThrottling`) keep the renderer foregrounded for the whole run.
 * `--autoplay-policy=no-user-gesture-required` lets the audio context resume from the verification
 * hook's `audioUnlock()` without a synthetic fullscreen-requesting click (headless fullscreen would
 * otherwise re-size the canvas mid-run).
 * `--enable-precise-memory-info` makes `performance.memory` fine-grained enough for the heap series.
 *
 * Run: `SOAK2H=1 npx playwright test --config playwright.soak2h.config.ts` (or `npm run test:soak2h`).
 */

const GPU_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--ignore-gpu-blocklist',
  '--enable-unsafe-swiftshader',
];

const SOAK_ARGS = [
  ...GPU_ARGS,
  '--use-angle=vulkan',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
  '--autoplay-policy=no-user-gesture-required',
  '--enable-precise-memory-info',
];

const launchOptions = { channel: 'chromium' as const, headless: true, args: SOAK_ARGS };

/**
 * Control project: the same soak spec on the **headed** path (a real window positioned off-screen so
 * it never takes focus), which is the operator's actual presentation path. Used only to check whether
 * an anomaly seen headless also reproduces headed. Not part of the acceptance run.
 */
const headedLaunchOptions = {
  channel: 'chromium' as const,
  headless: false,
  args: [...GPU_ARGS, '--use-gl=angle', '--use-angle=gl-egl', '--window-position=-32000,-32000', '--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'],
};

export default defineConfig({
  testDir: 'tests/browser',
  testMatch: '**/soak2h.spec.ts',
  // The spec sets its own (2h + margin) timeout; this is a backstop only.
  timeout: 4 * 60 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // No JSON reporter: the shared suite's `artifacts/playwright-report.json` must stay untouched.
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5199',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    launchOptions,
  },
  projects: [
    { name: 'soak2h', use: { launchOptions } },
    { name: 'soak2h-headed', use: { launchOptions: headedLaunchOptions } },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5199',
    url: 'http://127.0.0.1:5199',
    env: { VITE_TEST: '1' },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
