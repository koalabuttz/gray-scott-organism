/**
 * Shared float-record helpers (Phase 2/3): the float-renderable format description and the 1×1 health
 * record decode. Kept dependency-free so both the main-thread analyzer and the module worker can use
 * them without pulling in GL code.
 */

export interface FloatFormat {
  name: 'RGBA32F' | 'RGBA16F';
  internalFormat: number;
  readType: number;
  bytesPerTexel: number;
}

/**
 * Read the 1×1 float health record at `offset` (RGBA32F -> 4 floats; RGBA16F -> 4 decoded halves).
 * Pure, so the fallback decode is unit-testable without a GL context.
 */
export function decodeHealthRecordAt(
  bytes: Uint8Array,
  offset: number,
  format: 'RGBA32F' | 'RGBA16F',
): [number, number, number] {
  if (format === 'RGBA32F') {
    const view = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    const base = offset / 4;
    return [view[base] ?? 0, view[base + 1] ?? 0, view[base + 2] ?? 0];
  }
  const view = new Uint16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const base = offset / 2;
  return [decodeHalf(view[base] ?? 0), decodeHalf(view[base + 1] ?? 0), decodeHalf(view[base + 2] ?? 0)];
}

/** IEEE-754 binary16 -> number. */
export function decodeHalf(value: number): number {
  const sign = (value & 0x8000) !== 0 ? -1 : 1;
  const exponent = (value >> 10) & 0x1f;
  const mantissa = value & 0x03ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}
