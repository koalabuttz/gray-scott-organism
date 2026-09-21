/**
 * §10 capture helpers (PNG screenshot, WebM recording).
 *
 * Screenshots read the renderer's final composite in the same task as the draw, so no
 * `preserveDrawingBuffer` is required. Recording uses `canvas.captureStream` with
 * `MediaRecorder.isTypeSupported` to choose a codec; when the §8 audio system supplies tracks from
 * its MediaStream destination they are muxed in, so a recording is A/V rather than video-only.
 */

const DEFAULT_WEBM_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const;

/** When audio is muxed in, prefer an explicit audio codec so the container is unambiguous. */
const AUDIO_WEBM_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
] as const;

export function pickRecordingMimeType(candidates: readonly string[] = DEFAULT_WEBM_TYPES): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('canvas.toBlob produced no data'));
      },
      type,
      1,
    );
  });
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoke on the next tick; the navigation has already taken a reference.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface CanvasRecording {
  readonly mimeType: string;
  stop(): Promise<Blob>;
  readonly track: MediaStreamTrack;
}

export interface RecordingOptions {
  fps?: number;
  bitrate?: number;
  mimeTypes?: readonly string[];
  /**
   * §8.3/§10 audio tracks (usually from the audio system's MediaStream destination) to mux into the
   * recording. They are added to the canvas capture stream; the recorder then produces A/V WebM.
   */
  audioTracks?: readonly MediaStreamTrack[];
}

export function startCanvasRecording(
  canvas: HTMLCanvasElement,
  options: RecordingOptions = {},
): CanvasRecording {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder is unavailable in this browser');
  }
  const audioTracks = options.audioTracks ?? [];
  const candidates =
    options.mimeTypes ?? (audioTracks.length > 0 ? AUDIO_WEBM_TYPES : DEFAULT_WEBM_TYPES);
  const mimeType = pickRecordingMimeType(candidates);
  if (!mimeType) {
    throw new Error('no supported WebM recording codec reported by MediaRecorder.isTypeSupported');
  }
  const stream = canvas.captureStream(options.fps ?? 30);
  for (const track of audioTracks) stream.addTrack(track);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('captureStream produced no video track');

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: options.bitrate ?? 12_000_000,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  recorder.start(1000);

  return {
    mimeType,
    track,
    stop(): Promise<Blob> {
      return new Promise((resolve, reject) => {
        const finalize = () => {
          track.stop();
          resolve(new Blob(chunks, { type: mimeType }));
        };
        recorder.onerror = () => {
          track.stop();
          reject(new Error('MediaRecorder error'));
        };
        recorder.onstop = finalize;
        if (recorder.state === 'inactive') {
          finalize();
        } else {
          recorder.stop();
        }
      });
    },
  };
}
