/**
 * WebM verification for the Phase 1 gate clip ("check the WebM's actual duration/codec").
 *
 * MediaRecorder writes a live WebM: the Segment carries no `Duration` element, so container-level
 * duration tools report `Duration: N/A` and the nominal `30 fps` tells you nothing about how long
 * the clip really is. This module therefore verifies the file two independent ways:
 *
 *   1. `ffmpegInfo`  — asks ffmpeg (Playwright's bundled build) what the container and codec are.
 *   2. `inspectWebm` — parses the EBML structure directly: TimecodeScale, PixelWidth/Height,
 *      CodecID, every Cluster timecode and SimpleBlock timestamp. From the block timestamps it
 *      derives the real span, the frame count, the median frame interval (so dropped frames are
 *      visible) and a duration.
 *
 * No third-party dependency is used, which keeps this usable on any machine that can run the repo.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface WebmMetadata {
  bytes: number;
  codecId: string | null;
  pixelWidth: number | null;
  pixelHeight: number | null;
  timecodeScaleNs: number;
  clusters: number;
  frames: number;
  firstFrameMs: number | null;
  lastFrameMs: number | null;
  medianFrameIntervalMs: number | null;
  maxFrameIntervalMs: number | null;
  /** (last - first + median interval) in seconds, from the file's own timestamps. */
  durationSeconds: number | null;
  /** Effective frame rate including any dropped frames. */
  effectiveFps: number | null;
  /** Container-level duration element, if the muxer wrote one. */
  declaredDurationSeconds: number | null;
  parseError: string | null;
}

export interface FfmpegInfo {
  available: boolean;
  binary: string | null;
  codecLine: string | null;
  durationLine: string | null;
  raw: string;
}

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  CodecID: 0x86,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
} as const;

const CONTAINER_IDS = new Set<number>([
  ID.EBML,
  ID.Segment,
  ID.Info,
  ID.Tracks,
  ID.TrackEntry,
  ID.Video,
]);

/**
 * Level-1 element ids. A MediaRecorder WebM writes Clusters with an *unknown* size (the
 * live-streaming convention), which means a cluster's content runs until the next level-1 element
 * rather than for a declared length. Without this, one cluster appears to swallow the whole file.
 */
const LEVEL1_IDS = new Set<number>([
  ID.Cluster,
  0x1c53bb6b, // Cues
  0x1254c367, // Tags
  0x114d9b74, // SeekHead
  ID.Info,
  ID.Tracks,
  0x1941a469, // Attachments
  0x1043a770, // Chapters
]);

function readElementId(buffer: Buffer, offset: number): { id: number; length: number } {
  const first = buffer[offset];
  if (first === undefined) throw new Error(`unexpected end of file at ${offset}`);
  let length = 1;
  let mask = 0x80;
  while (length <= 4 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 4) throw new Error(`invalid element id at ${offset}`);
  let id = 0;
  for (let i = 0; i < length; i += 1) id = id * 256 + (buffer[offset + i] ?? 0);
  return { id, length };
}

function readElementSize(buffer: Buffer, offset: number): { size: number | null; length: number } {
  const first = buffer[offset];
  if (first === undefined) throw new Error(`unexpected end of file at ${offset}`);
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8) throw new Error(`invalid element size at ${offset}`);
  let raw = 0;
  for (let i = 0; i < length; i += 1) raw = raw * 256 + (buffer[offset + i] ?? 0);
  // For an L-byte vint the length marker is the top bit of the first byte, whose place value in the
  // whole (big-endian, L-byte) number is 2^(7L). All-ones data bits mean "unknown size".
  const value = raw - Math.pow(2, 7 * length);
  const unknown = value === Math.pow(2, 7 * length) - 1;
  return { size: unknown ? null : value, length };
}

function readUint(buffer: Buffer, start: number, end: number): number {
  let value = 0;
  for (let i = start; i < end; i += 1) value = value * 256 + (buffer[i] ?? 0);
  return value;
}

function readVintNumber(buffer: Buffer, offset: number): { value: number; length: number } {
  const first = buffer[offset];
  if (first === undefined) throw new Error(`unexpected end of file at ${offset}`);
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8) throw new Error(`invalid vint at ${offset}`);
  let raw = 0;
  for (let i = 0; i < length; i += 1) raw = raw * 256 + (buffer[offset + i] ?? 0);
  return { value: raw - Math.pow(2, 7 * length), length };
}

/** Parse the file's own timestamps. Never throws: failures are reported in `parseError`. */
export function inspectWebm(path: string): WebmMetadata {
  const result: WebmMetadata = {
    bytes: existsSync(path) ? statSync(path).size : 0,
    codecId: null,
    pixelWidth: null,
    pixelHeight: null,
    timecodeScaleNs: 1_000_000,
    clusters: 0,
    frames: 0,
    firstFrameMs: null,
    lastFrameMs: null,
    medianFrameIntervalMs: null,
    maxFrameIntervalMs: null,
    durationSeconds: null,
    effectiveFps: null,
    declaredDurationSeconds: null,
    parseError: null,
  };
  if (!existsSync(path)) {
    result.parseError = `file not found: ${path}`;
    return result;
  }

  const buffer = readFileSync(path);
  const timestamps: number[] = [];
  let clusterTimecode = 0;

  const recordBlock = (contentStart: number): void => {
    try {
      const track = readVintNumber(buffer, contentStart);
      const relative = buffer.readInt16BE(contentStart + track.length);
      timestamps.push(clusterTimecode + relative);
    } catch {
      // A malformed block should not invalidate the rest of the measurement.
    }
  };

  /**
   * Walk elements in [start, end). Returns the offset at which walking stopped: for a parent with
   * a known size that is `end`; for an unknown-size container it is the offset of the level-1
   * element that terminates it.
   */
  const walkElements = (start: number, end: number, stopAtLevel1: boolean, inCluster: boolean): number => {
    let offset = start;
    while (offset < end) {
      const { id, length: idLength } = readElementId(buffer, offset);
      if (stopAtLevel1 && LEVEL1_IDS.has(id)) return offset;
      const { size, length: sizeLength } = readElementSize(buffer, offset + idLength);
      const contentStart = offset + idLength + sizeLength;
      const contentEnd = size === null ? end : Math.min(end, contentStart + size);
      const unknownSize = size === null;

      if (id === ID.Cluster) {
        result.clusters += 1;
        clusterTimecode = 0;
        const stop = walkElements(contentStart, contentEnd, unknownSize, true);
        offset = unknownSize ? stop : contentEnd;
        continue;
      }
      if (CONTAINER_IDS.has(id) || id === ID.BlockGroup) {
        walkElements(contentStart, contentEnd, false, inCluster);
        offset = contentEnd;
        continue;
      }
      if (id === ID.Timecode) {
        clusterTimecode = readUint(buffer, contentStart, contentEnd);
      } else if (id === ID.TimecodeScale) {
        result.timecodeScaleNs = readUint(buffer, contentStart, contentEnd);
      } else if (id === ID.Duration) {
        const bytes = contentEnd - contentStart;
        if (bytes === 4) result.declaredDurationSeconds = buffer.readFloatBE(contentStart);
        else if (bytes === 8) result.declaredDurationSeconds = buffer.readDoubleBE(contentStart);
      } else if (id === ID.CodecID) {
        result.codecId = buffer.subarray(contentStart, contentEnd).toString('utf8');
      } else if (id === ID.PixelWidth) {
        result.pixelWidth = readUint(buffer, contentStart, contentEnd);
      } else if (id === ID.PixelHeight) {
        result.pixelHeight = readUint(buffer, contentStart, contentEnd);
      } else if (id === ID.SimpleBlock || id === ID.Block) {
        recordBlock(contentStart);
      }
      offset = contentEnd;
    }
    return offset;
  };

  try {
    walkElements(0, buffer.length, false, false);
  } catch (error) {
    result.parseError = String(error);
  }

  if (timestamps.length > 0) {
    const ordered = timestamps.slice().sort((a, b) => a - b);
    const deltas: number[] = [];
    for (let i = 1; i < ordered.length; i += 1) {
      const delta = ordered[i]! - ordered[i - 1]!;
      if (delta > 0) deltas.push(delta);
    }
    deltas.sort((a, b) => a - b);
    const median = deltas.length > 0 ? deltas[Math.floor(deltas.length / 2)]! : 0;
    const max = deltas.length > 0 ? deltas[deltas.length - 1]! : 0;
    const scaleMs = result.timecodeScaleNs / 1_000_000;
    const first = ordered[0]! * scaleMs;
    const last = ordered[ordered.length - 1]! * scaleMs;
    result.frames = timestamps.length;
    result.firstFrameMs = first;
    result.lastFrameMs = last;
    result.medianFrameIntervalMs = median * scaleMs;
    result.maxFrameIntervalMs = max * scaleMs;
    result.durationSeconds = (last - first + median * scaleMs) / 1000;
    result.effectiveFps = last > first ? ((timestamps.length - 1) * 1000) / (last - first) : null;
  }
  return result;
}

/** Ask ffmpeg what the container/codec look like, if an ffmpeg binary is available. */
export function ffmpegInfo(path: string): FfmpegInfo {
  const candidates = [
    join(homedir(), '.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux'),
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ];
  const binary = candidates.find((candidate) => existsSync(candidate)) ?? null;
  if (!binary) return { available: false, binary: null, codecLine: null, durationLine: null, raw: '' };
  try {
    // `-i` alone is an error exit for ffmpeg; the report goes to stderr.
    execFileSync(binary, ['-i', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { available: true, binary, codecLine: null, durationLine: null, raw: '' };
  } catch (error) {
    const raw = String((error as { stderr?: string }).stderr ?? '');
    const codecLine = raw.split('\n').find((line) => line.includes('Stream #'))?.trim() ?? null;
    const durationLine = raw.split('\n').find((line) => line.includes('Duration:'))?.trim() ?? null;
    return { available: true, binary, codecLine, durationLine, raw };
  }
}
