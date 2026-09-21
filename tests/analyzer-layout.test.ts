/**
 * The combined-sample slot layout is qualified per float format. The canonical §3.3 offset is adopted
 * (deviation 46): the presentation map starts at 0, the 1×1 float health record sits at `0x40000`, and
 * the 16×16 framing map is appended at the fixed `0x40010` (16 bytes are reserved for the health
 * record so the framing offset is format-independent). The RGBA16F fallback — which the ordinary
 * machine never takes, because RGBA32F is renderable — must be exercisable without a GL context.
 */
import { describe, expect, it } from 'vitest';
import {
  FRAMING_OFFSET,
  HEALTH_OFFSET,
  analysisSlotLayout,
  decodeHealthRecord,
  pickFloatFormat,
  type FloatFormat,
} from '../src/analysis/analyzer.ts';

/** The WebGL2 constants `pickFloatFormat` reads, plus the error drain it uses on failure. */
const GL = {
  RGBA32F: 0x8814,
  RGBA16F: 0x881a,
  RGBA: 0x1908,
  FLOAT: 0x1406,
  HALF_FLOAT: 0x140b,
  NEAREST: 0x2600,
  NO_ERROR: 0,
  getError: () => 0,
} as unknown as WebGL2RenderingContext;

describe('§3.3 combined-sample layout (deviation 46)', () => {
  it('puts the health record at the canonical 0x40000 and the framing map at 0x40010', () => {
    expect(HEALTH_OFFSET).toBe(0x40000);
    expect(FRAMING_OFFSET).toBe(0x40010);
    const float32 = analysisSlotLayout(16);
    expect(float32.healthOffset).toBe(0x40000);
    expect(float32.framingOffset).toBe(0x40010);
    expect(float32.healthBytes).toBe(16);
    expect(float32.slotBytes).toBe(0x40010 + 16 * 16 * 4);
    const half = analysisSlotLayout(8);
    expect(half.healthOffset).toBe(0x40000);
    expect(half.framingOffset).toBe(0x40010);
    expect(half.healthBytes).toBe(8);
    expect(half.slotBytes).toBe(float32.slotBytes); // reserved 16 bytes keep the offsets fixed
  });

  it('falls back to RGBA16F when the renderability probe rejects RGBA32F', () => {
    const rejected: string[] = [];
    const allocate = (candidate: FloatFormat): void => {
      rejected.push(candidate.name);
      if (candidate.name === 'RGBA32F') throw new Error('not colour-renderable');
    };
    const format = pickFloatFormat(GL, {} as never, allocate);
    expect(format.name).toBe('RGBA16F');
    expect(format.bytesPerTexel).toBe(8);
    expect(rejected).toEqual(['RGBA32F', 'RGBA16F']);
  });

  it('still selects RGBA32F when the probe accepts it', () => {
    const allocate = (candidate: FloatFormat): void => {
      if (candidate.name === 'RGBA16F') throw new Error('unexpected second probe');
    };
    expect(pickFloatFormat(GL, {} as never, allocate).name).toBe('RGBA32F');
  });

  it('decodes the 1x1 health record at 0x40000 for both formats', () => {
    // RGBA16F: half-encoded (0x3800 = 0.5, 0x3400 = 0.25, 0x3000 = 0.125).
    const halfSlot = new Uint8Array(analysisSlotLayout(8).slotBytes);
    new Uint16Array(halfSlot.buffer, HEALTH_OFFSET, 4).set([0x3800, 0x3400, 0x3000, 0x3c00]);
    const half = decodeHealthRecord(halfSlot, 'RGBA16F');
    expect(half[0]).toBeCloseTo(0.5, 6);
    expect(half[1]).toBeCloseTo(0.25, 6);
    expect(half[2]).toBeCloseTo(0.125, 6);

    // RGBA32F: exact float32.
    const floatSlot = new Uint8Array(analysisSlotLayout(16).slotBytes);
    new Float32Array(floatSlot.buffer, HEALTH_OFFSET, 4).set([0.75, 0.5, 0.25, 0]);
    const floats = decodeHealthRecord(floatSlot, 'RGBA32F');
    expect(floats[0]).toBeCloseTo(0.75, 6);
    expect(floats[1]).toBeCloseTo(0.5, 6);
    expect(floats[2]).toBeCloseTo(0.25, 6);
  });
});
