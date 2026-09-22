/**
 * Scratch probe #3 (not a deliverable): test whether scheduling the bloom attack curve with a
 * `when` that is already in the past (but positive) reproduces the observed overlap error.
 */
import { chromium } from '@playwright/test';

const args = ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
const browser = await chromium.launch({ channel: 'chromium', headless: true, args });
const page = await browser.newPage();
await page.setContent('<html><body></body></html>');

const out = await page.evaluate(async () => {
  const attack = 0.18;
  const rate = 48000;
  const curve = () => {
    const n = Math.max(2, Math.round(attack * rate));
    const a = new Float32Array(n);
    for (let i = 0; i < n; i += 1) a[i] = 0.2 * 0.5 * (1 - Math.cos((Math.PI * i) / (n - 1)));
    return a;
  };
  const results = {};
  const ctx = new AudioContext();
  await ctx.resume();
  // Let the context clock advance so a "past" time is still positive.
  await new Promise((r) => setTimeout(r, 300));
  results['currentTime'] = ctx.currentTime;
  results['sampleRate'] = ctx.sampleRate;

  const tryPattern = (label, offsetSeconds) => {
    try {
      const g = ctx.createGain();
      const when = ctx.currentTime + offsetSeconds;
      if (when <= 0) {
        results[label] = `skipped (when=${when} <= 0)`;
        return;
      }
      g.gain.setValueCurveAtTime(curve(), when, attack);
      g.gain.setTargetAtTime(0, when + attack, 0.85);
      results[label] = `no throw (when = now ${offsetSeconds >= 0 ? '+' : ''}${offsetSeconds}s)`;
    } catch (error) {
      results[label] = `throw: ${String(error)}`;
    }
  };

  tryPattern('future_50ms', 0.05);
  tryPattern('future_5ms', 0.005);
  tryPattern('past_2ms', -0.002);
  tryPattern('past_5ms', -0.005);
  tryPattern('past_13ms', -0.0133);
  tryPattern('past_21ms', -0.0213);
  tryPattern('past_40ms', -0.04);

  await ctx.close();
  return results;
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
