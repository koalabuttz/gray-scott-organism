/**
 * Laboratory-only diagnostics formatting and a bounded frame-time ring (§3.3 Diagnostics).
 *
 * Nothing here is ever displayed in presentation mode: it is consumed by `lab/lab.ts` only.
 */
import type { Diagnostics, GLResourceCounts } from '../core/types.ts';

export class FrameTimeRing {
  private readonly values: number[];
  private cursor = 0;
  private filled = 0;

  constructor(readonly capacity = 240) {
    this.values = new Array<number>(capacity).fill(0);
  }

  push(value: number): void {
    this.values[this.cursor] = value;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;
  }

  snapshot(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.filled; i += 1) {
      const index = (this.cursor - this.filled + i + this.capacity) % this.capacity;
      out.push(this.values[index]!);
    }
    return out;
  }

  percentile(p: number): number {
    const sorted = this.snapshot().sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[index]!;
  }

  average(): number {
    const data = this.snapshot();
    if (data.length === 0) return 0;
    return data.reduce((sum, value) => sum + value, 0) / data.length;
  }
}

export function formatDiagnostics(
  diagnostics: Diagnostics,
  counts: GLResourceCounts,
  extra: Record<string, string>,
): string {
  const frame = diagnostics.frameTimesMs;
  const lines: string[] = [];
  lines.push(`renderer   ${diagnostics.rendererInfo}`);
  lines.push(`software   ${diagnostics.softwareRenderer ? 'YES (not the target GPU)' : 'no'}`);
  lines.push(`frames     n=${frame.length} avg=${diagnostics.frameTimesMs.length ? average(frame).toFixed(2) : '0'}ms`);
  lines.push(`sim        ${diagnostics.simulationMsAvg.toFixed(2)}ms avg`);
  lines.push(`render     ${diagnostics.renderMsAvg.toFixed(2)}ms avg`);
  const deliveredSteps = diagnostics.simStepsPerSecond;
  const desiredSteps = diagnostics.desiredStepsPerSecond;
  const capBinds = deliveredSteps + 1 < desiredSteps;
  lines.push(
    `sim steps  ${deliveredSteps.toFixed(0)}/s delivered of ${desiredSteps.toFixed(0)}/s desired` +
      (capBinds ? '  <-- cap binds (running slower than requested)' : ''),
  );
  lines.push(`fps        ${diagnostics.deliveredFps.toFixed(1)}`);
  lines.push(`tier       ${diagnostics.qualityTier}  overload=${diagnostics.overload ? 'yes' : 'no'}`);
  lines.push(`analysis   backlog=${diagnostics.analysisBacklog} (presentation worker, one in flight)`);
  lines.push(
    `gl objects tex=${counts.textures} fbo=${counts.framebuffers} rb=${counts.renderbuffers} ` +
      `prog=${counts.programs} vao=${counts.vertexArrays} buf=${counts.buffers}`,
  );
  for (const [key, value] of Object.entries(extra)) {
    lines.push(`${key.padEnd(10)} ${value}`);
  }
  return lines.join('\n');
}

export function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}
