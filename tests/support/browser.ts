/**
 * Playwright helpers for the artwork's browser verification.
 *
 * The in-page verification hook (`window.__artwork`) is not UI and never touches the DOM: it is
 * how the specs drive the real GPU pipeline deterministically without a second solver.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Page } from '@playwright/test';

export const ARTIFACTS_DIR = resolve(process.cwd(), 'artifacts');

export function writeArtifact(relativePath: string, content: string | Buffer): string {
  const target = resolve(ARTIFACTS_DIR, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

export interface LaunchProbe {
  ok: boolean;
  reason: string;
}

/** Load the artwork and wait for either the verification hook or a fatal error overlay. */
export async function openArtwork(page: Page): Promise<LaunchProbe> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/', { waitUntil: 'load' });
  const handle = await page.waitForFunction(
    () => {
      const scope = window as unknown as { __artwork?: unknown };
      if (scope.__artwork) return { ok: true, reason: '' };
      const overlay = document.querySelector('.artwork-error');
      if (overlay) return { ok: false, reason: (overlay.textContent ?? 'unknown startup failure').trim() };
      return false;
    },
    undefined,
    { timeout: 60_000 },
  );
  const probe = (await handle.jsonValue()) as LaunchProbe;
  if (!probe.ok && errors.length > 0) {
    probe.reason = `${probe.reason} | page errors: ${errors.join('; ')}`;
  }
  return probe;
}

/** Call a method on the in-page verification hook and return its JSON value. */
export async function hook<T>(page: Page, method: string, args: unknown[] = []): Promise<T> {
  return (await page.evaluate(
    ({ method: name, args: parameters }) => {
      const scope = window as unknown as { __artwork: Record<string, (...a: unknown[]) => unknown> };
      const fn = scope.__artwork[name];
      if (typeof fn !== 'function') throw new Error(`hook method ${name} is missing`);
      return fn.apply(scope.__artwork, parameters ?? []) as unknown;
    },
    { method, args },
  )) as T;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}

export interface HarnessLaunchOptions {
  args?: string[];
  headless?: boolean;
}

/**
 * Describes which browser harness produced an artifact, so a capability report can never be read
 * without knowing whether it came from a headless or a headed run (and whether that run reached
 * the real GPU or a software rasteriser).
 */
export function harnessSection(
  projectName: string,
  launchOptions: HarnessLaunchOptions | undefined,
  facts: { renderer: string; softwareRenderer: boolean; colorBufferFloat: boolean },
): string {
  const args = launchOptions?.args ?? [];
  const headless = launchOptions?.headless !== false;
  const mode = headless
    ? 'headless (Chromium new headless through the `chromium` channel) — no window is created, so a test run cannot take foreground focus'
    : 'headed, window positioned at -32000,-32000 so it never appears on screen or takes foreground focus (not started minimized: a minimized window throttles rAF and would invalidate the timing assertions)';
  return [
    '',
    '## Test harness',
    '',
    `- Playwright project: \`${projectName}\``,
    `- Mode: ${mode}`,
    `- Launch arguments: \`${args.join(' ')}\``,
    `- Renderer reached by this run: \`${facts.renderer}\``,
    `- Software rasteriser: **${facts.softwareRenderer}**`,
    `- \`EXT_color_buffer_float\` present in this run: **${facts.colorBufferFloat}**`,
    '- The default suite (`npm run test:browser`) runs the headless project; a headless run on this',
    '  machine still reaches the real GPU because ANGLE\'s Vulkan backend drives the Intel device',
    '  through the DRI render node. The old headless shell has no such path and falls back to',
    '  SwiftShader, which is why the `chromium` channel is required rather than assumed.',
    '- Reference readings from a headed run on the same machine (ANGLE + Mesa GL-ES path, the',
    '  operator\'s actual presentation path): `ANGLE (Intel, Mesa Intel(R) Graphics (RPL-U),',
    '  OpenGL ES 3.2)` with the same format results. The two paths agree on every assertion in this',
    '  report; the renderer strings differ, which is why both are recorded.',
    '',
  ].join('\n');
}
