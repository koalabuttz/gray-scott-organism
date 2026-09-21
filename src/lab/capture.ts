/**
 * Laboratory capture helpers: PNG screenshot and WebM recording controls (§10).
 *
 * Screenshots are captured from the renderer's final composite frame; the returned blob is
 * offered as a download. Recording uses `canvas.captureStream` + `MediaRecorder` and is silent
 * until an audio system exists.
 */
import { blobToBase64, downloadBlob } from '../visual/capture.ts';
import { createButton, createReadout } from './controls.ts';

export interface CaptureApi {
  screenshot(): Promise<{ blob: Blob; filename: string }>;
  startRecording(): Promise<{ mimeType: string }>;
  stopRecording(): Promise<{ blob: Blob; filename: string }>;
  recordingSupport(): { supported: boolean; mimeType: string };
  stateSnapshot(): string;
  mimeForCapture(): string;
}

export function createCaptureControls(parent: HTMLElement, api: CaptureApi): void {
  const status = createReadout(parent);
  const support = api.recordingSupport();
  status.set(
    support.supported
      ? `recording: ${support.mimeType}`
      : 'recording: unsupported by this browser (screenshots still work)',
  );

  createButton(parent, 'screenshot (png)', () => {
    void (async () => {
      const { blob, filename } = await api.screenshot();
      downloadBlob(blob, filename);
      status.set(`saved ${filename} (${Math.round(blob.size / 1024)} KiB)`);
    })().catch((error: unknown) => status.set(`screenshot failed: ${String(error)}`));
  });

  createButton(parent, 'copy screenshot base64', () => {
    void (async () => {
      const { blob } = await api.screenshot();
      const base64 = await blobToBase64(blob);
      (window as unknown as { __lastCaptureBase64?: string }).__lastCaptureBase64 = base64;
      status.set(`base64 available as window.__lastCaptureBase64 (${base64.length} chars)`);
    })().catch((error: unknown) => status.set(`capture failed: ${String(error)}`));
  });

  createButton(parent, 'copy state snapshot', () => {
    const snapshot = api.stateSnapshot();
    (window as unknown as { __lastStateSnapshot?: string }).__lastStateSnapshot = snapshot;
    status.set('state snapshot available as window.__lastStateSnapshot');
  });

  if (!support.supported) return;

  createButton(parent, 'start recording', () => {
    void api
      .startRecording()
      .then((info) => status.set(`recording (${info.mimeType})`))
      .catch((error: unknown) => status.set(`start failed: ${String(error)}`));
  });

  createButton(parent, 'stop recording', () => {
    void api
      .stopRecording()
      .then(({ blob, filename }) => {
        downloadBlob(blob, filename);
        status.set(`saved ${filename} (${Math.round(blob.size / 1024)} KiB)`);
      })
      .catch((error: unknown) => status.set(`stop failed: ${String(error)}`));
  });

  createButton(parent, 'test codecs', () => {
    status.set(api.mimeForCapture() || 'no supported WebM codec reported');
  });
}
