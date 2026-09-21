/**
 * §10 command surface shared by the laboratory and application transport.
 *
 * Commands are validated and applied at the next update boundary. Phase 1 implements the subset
 * the gate needs (restart, reseed, pause, speed, parameter override, camera override,
 * diagnostics view); trajectory loading and movement skipping arrive with the curator in
 * Phase 2 and are deliberately absent rather than stubbed.
 */
import type { GenesisCommand, Params } from './types.ts';
import type { TrajectoryDocument } from '../curator/schema.ts';
import { PARAM_ENVELOPE, TIME } from '../config.ts';

export type CameraOverride = Readonly<{
  mode?: 'overhead' | 'approach' | 'horizon' | 'retreat';
  focusUV?: readonly [number, number];
  yawRadians?: number;
  elevationRadians?: number;
  distance?: number;
  verticalFovRadians?: number;
  transitionSeconds?: number;
}>;

export type AppCommand =
  | { type: 'restart'; seed?: number }
  | { type: 'reseed'; genesis: GenesisCommand }
  | { type: 'pause'; value: boolean }
  | { type: 'speed'; value: number }
  | { type: 'parameters'; value: Params; mode: 'override' | 'release' }
  | { type: 'camera'; value: CameraOverride | null }
  | { type: 'diagnostics'; view: 'none' | 'analysis' | 'topology' | 'spectrum' | 'camera' }
  | { type: 'mute'; value: boolean }
  /** §10 bounded exploration mode: switch to the coarser lab-only simulation grid (restarts chemistry). */
  | { type: 'exploration'; value: boolean }
  /** §10 composition controls: advance the curator to its next movement without a chemistry reset. */
  | { type: 'skip-movement' }
  /** §10 trajectory import: make a validated document the active composition. */
  | { type: 'load-trajectory'; document: TrajectoryDocument };

export interface ValidationResult {
  ok: boolean
  reason?: string;
}

/**
 * Validate a command. `speedRange` defaults to the presentation range; the application passes the
 * active resolution's range so a lab-only exploration session can use the higher ceiling it measured.
 */
export function validateCommand(
  command: AppCommand,
  options: { speedRange?: readonly [number, number] } = {},
): ValidationResult {
  const speedRange = options.speedRange ?? TIME.speedRange;
  switch (command.type) {
    case 'speed':
      if (!Number.isFinite(command.value)) return { ok: false, reason: 'speed must be finite' };
      if (command.value < speedRange[0] || command.value > speedRange[1]) {
        return { ok: false, reason: `speed must be within [${speedRange[0]}, ${speedRange[1]}]` };
      }
      return { ok: true };
    case 'exploration':
      if (typeof command.value !== 'boolean') return { ok: false, reason: 'exploration must be a boolean' };
      return { ok: true };
    case 'skip-movement':
      return { ok: true };
    case 'load-trajectory':
      if (typeof command.document !== 'object' || command.document === null || !Array.isArray(command.document.movements)) {
        return { ok: false, reason: 'trajectory document must carry a movements array' };
      }
      return { ok: true };
    case 'parameters':
      return validateParameters(command.value);
    case 'reseed':
      if (!Number.isFinite(command.genesis.radiusCells) || command.genesis.radiusCells <= 0) {
        return { ok: false, reason: 'genesis radius must be a positive number of cells' };
      }
      if (command.genesis.center.length !== 2 || !command.genesis.center.every(Number.isFinite)) {
        return { ok: false, reason: 'genesis center must be a finite pair' };
      }
      return { ok: true };
    case 'restart':
      if (command.seed !== undefined && !Number.isFinite(command.seed)) {
        return { ok: false, reason: 'seed must be finite' };
      }
      return { ok: true };
    default:
      return { ok: true };
  }
}

/** §6.2 laboratory safety envelope, enforced before any parameter reaches the solver. */
export function validateParameters(value: Params): ValidationResult {
  if (
    !Number.isFinite(value.F) ||
    !Number.isFinite(value.k) ||
    !Number.isFinite(value.Du) ||
    !Number.isFinite(value.Dv)
  ) {
    return { ok: false, reason: 'parameters must be finite' };
  }
  if (value.F < PARAM_ENVELOPE.F[0] || value.F > PARAM_ENVELOPE.F[1]) {
    return { ok: false, reason: `F must be within [${PARAM_ENVELOPE.F[0]}, ${PARAM_ENVELOPE.F[1]}]` };
  }
  if (value.k < PARAM_ENVELOPE.k[0] || value.k > PARAM_ENVELOPE.k[1]) {
    return { ok: false, reason: `k must be within [${PARAM_ENVELOPE.k[0]}, ${PARAM_ENVELOPE.k[1]}]` };
  }
  if (value.Du <= PARAM_ENVELOPE.Du[0] || value.Du > PARAM_ENVELOPE.Du[1]) {
    return { ok: false, reason: `Du must be within (${PARAM_ENVELOPE.Du[0]}, ${PARAM_ENVELOPE.Du[1]}]` };
  }
  if (value.Dv <= PARAM_ENVELOPE.Dv[0] || value.Dv > PARAM_ENVELOPE.Dv[1]) {
    return { ok: false, reason: `Dv must be within (${PARAM_ENVELOPE.Dv[0]}, ${PARAM_ENVELOPE.Dv[1]}]` };
  }
  // The classical diffusion stability bound is necessary, not sufficient; also validated here.
  const dt = TIME.dt;
  if (dt * Math.max(value.Du, value.Dv) > 0.25) {
    return { ok: false, reason: 'dt * max(Du,Dv) must not exceed 0.25' };
  }
  return { ok: true };
}
