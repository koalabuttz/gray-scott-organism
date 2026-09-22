import { defineConfig } from '@playwright/test';

/**
 * Browser harness modes, defined once and shared by every project.
 *
 * The default suite runs **headless on the real GPU**. Chromium's new headless mode (the
 * `chromium` channel) can reach the hardware through ANGLE's Vulkan backend, so a normal test run
 * never opens a window and never takes foreground focus, while still exercising the actual GPU:
 * verified on this machine as
 * `ANGLE (Intel, Vulkan 1.4.305 (Intel(R) Graphics (RPL-U)), Intel open-source Mesa driver)` with
 * `EXT_color_buffer_float` present and RG32F / RGBA16F / DEPTH_COMPONENT24 all framebuffer-complete.
 *
 * The old headless *shell* has no GPU path on Linux (it falls back to SwiftShader), which is why
 * `channel: 'chromium'` is required rather than assumed.
 *
 * A second project, `headed-offscreen`, is provided for evidence that genuinely needs a real
 * window. It is never run by default (`npm run test:browser` selects the headless project) and it
 * positions its window at -32000,-32000 so it cannot appear on screen or take focus. It is
 * deliberately *not* started minimized: a minimized window has its rAF throttled, which would
 * invalidate every timing and rendering assertion.
 */
const GPU_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];

export type HarnessMode = 'headless' | 'headedOffscreen' | 'softwareCheck';

export interface HarnessLaunch {
  channel: 'chromium';
  headless: boolean;
  args: string[];
}

export const BROWSER_HARNESS: Record<HarnessMode, HarnessLaunch> = {
  /** Default: headless, real GPU through ANGLE/Vulkan, no window, no focus stealing. */
  headless: {
    channel: 'chromium',
    headless: true,
    args: [...GPU_ARGS, '--use-angle=vulkan'],
  },
  /** Opt-in: a real window, positioned far off-screen so it never takes foreground focus. */
  headedOffscreen: {
    channel: 'chromium',
    headless: false,
    args: [...GPU_ARGS, '--use-gl=angle', '--use-angle=gl-egl', '--window-position=-32000,-32000'],
  },
  /**
   * Opt-in, verification only: forces a software rasteriser so the suite's "report the renderer you
   * actually got, never silently pass a GPU test" discipline is itself testable. Correctness
   * assertions still run; performance and material-appearance claims do not apply.
   */
  softwareCheck: {
    channel: 'chromium',
    headless: true,
    args: [...GPU_ARGS, '--use-angle=swiftshader'],
  },
};

const viewport = { width: 1280, height: 720 };

/**
 * The `devices['Desktop Chrome']` preset is deliberately NOT used: it overrides `userAgent` with a
 * Windows desktop string, which made the capability report claim "Windows NT 10.0" while the
 * renderer was a Linux Mesa driver. The report is supposed to describe the machine it actually ran
 * on, so only the viewport and scale are pinned here and the browser reports its own identity.
 */
const browserContext = { viewport, deviceScaleFactor: 1 } as const;

export default defineConfig({
  testDir: 'tests/browser',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'artifacts/playwright-report.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:5199',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'headless-gpu',
      use: {
        ...browserContext,
        launchOptions: BROWSER_HARNESS.headless,
      },
    },
    {
      // Run explicitly: npx playwright test --project=headed-offscreen
      name: 'headed-offscreen',
      use: {
        ...browserContext,
        launchOptions: BROWSER_HARNESS.headedOffscreen,
      },
    },
    {
      // Run explicitly: npx playwright test --project=software-check --grep "AC.1"
      name: 'software-check',
      use: {
        ...browserContext,
        launchOptions: BROWSER_HARNESS.softwareCheck,
      },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5199',
    url: 'http://127.0.0.1:5199',
    // `VITE_TEST=1` makes `vite.config.ts` disable HMR, so a source-file write during a run cannot
    // reload the page mid-test (the shared root cause of the two observed browser flakes: a page
    // navigation destroying the evaluate context, and live state reverting to startup defaults).
    env: { VITE_TEST: '1' },
    // The suite must run against that HMR-suppressed server, so a *pre-existing* dev server (started
    // by `npm run dev`, HMR on) is not reused: reusing it would restore the reload behaviour. If one
    // is running on 5199 Playwright reports the port conflict explicitly rather than flaking silently.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
