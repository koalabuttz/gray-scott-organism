/**
 * §2.3 startup: black canvas, one explicit activation gesture, and a concise actionable error
 * instead of a convincing-looking fake simulation if the GPU cannot run the piece (§11.3).
 */
import './styles.css';
import { App } from './app.ts';

function showFatal(message: string, detail: string): void {
  const element = document.createElement('div');
  element.className = 'artwork-error';
  element.setAttribute('role', 'alert');
  const body = document.createElement('div');
  const heading = document.createElement('strong');
  heading.textContent = message;
  const secondary = document.createElement('p');
  secondary.textContent = detail;
  body.append(heading, secondary);
  element.appendChild(body);
  document.body.appendChild(element);
}

function reportFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[artwork] startup failed:', error);
  showFatal(
    'The artwork could not start on this machine.',
    `${message}\n\nWebGL2 with EXT_color_buffer_float is required for floating-point ` +
      'reaction-diffusion fields. See artifacts/capability-report.md and architecture-plan.md §11.3.',
  );
}

const canvas = document.getElementById('stage');
if (!(canvas instanceof HTMLCanvasElement)) {
  showFatal('The artwork could not start.', 'Expected a #stage canvas element in the document.');
} else {
  // Capability failures are thrown while the application is constructed (a missing required
  // extension, an incomplete required framebuffer, or a failed render probe), so both phases
  // must be guarded: a blank black page is not an acceptable failure mode.
  try {
    const app = new App({ canvas });
    app.init().catch(reportFailure);
    // Exposed for the laboratory and for browser-driven verification.
    (window as unknown as { __artworkApp?: App }).__artworkApp = app;
  } catch (error) {
    reportFailure(error);
  }
}
