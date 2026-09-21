/**
 * Shared helpers for the §12.2 Phase-2 acceptance-evidence specs.
 *
 * These specs are the machine half of the Phase-2 arc review (`Phase2ArcReview`): they record
 * gated, reproducible runs and write their artifacts under `artifacts/`. Everything here is thin
 * plumbing — PNG/JSON writers and an in-page tile montage — so the specs themselves stay about the
 * evidence rather than about image encoding.
 */
import { writeArtifact } from './browser.ts';
import type { Page } from '@playwright/test';

/** Decode a base64 PNG returned by `capturePngBase64()` and write it under `artifacts/`. */
export function writePng(relativePath: string, base64: string): string {
  return writeArtifact(relativePath, Buffer.from(base64, 'base64'));
}

/** Write pretty JSON under `artifacts/`. */
export function writeJson(relativePath: string, value: unknown): string {
  return writeArtifact(relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Compose a contact sheet from base64 PNG tiles, entirely in the page: each tile is decoded into an
 * `<img>`, drawn as a grid onto a 2D canvas (black gutter), and returned as a base64 PNG. This keeps
 * the evidence pipeline dependency-free — no image library, no native module.
 */
export async function montagePng(
  page: Page,
  tiles: readonly string[],
  columns: number,
  tileWidth = 512,
): Promise<string> {
  return page.evaluate(
    async ({ sources, columns: cols, tileWidth: tw }) => {
      const images = await Promise.all(
        sources.map(
          (src) =>
            new Promise<HTMLImageElement>((resolve, reject) => {
              const img = new Image();
              img.onload = () => resolve(img);
              img.onerror = () => reject(new Error('contact-sheet tile failed to decode'));
              img.src = `data:image/png;base64,${src}`;
            }),
        ),
      );
      if (images.length === 0) throw new Error('contact sheet needs at least one tile');
      const first = images[0]!;
      const rows = Math.ceil(images.length / cols);
      const tileHeight = Math.round((tw * first.height) / first.width);
      const canvas = document.createElement('canvas');
      canvas.width = cols * tw;
      canvas.height = rows * tileHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2D context unavailable for the contact sheet');
      context.fillStyle = '#000000';
      context.fillRect(0, 0, canvas.width, canvas.height);
      images.forEach((image, index) => {
        const cx = (index % cols) * tw;
        const cy = Math.floor(index / cols) * tileHeight;
        context.drawImage(image, cx, cy, tw, tileHeight);
      });
      const url = canvas.toDataURL('image/png');
      const comma = url.indexOf(',');
      return comma >= 0 ? url.slice(comma + 1) : url;
    },
    { sources: [...tiles], columns, tileWidth },
  );
}

/** Human-readable byte size, for the README/report. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
