/**
 * §6.2 trajectory document shape and validation.
 *
 * One versioned JSON document describes a bounded graph of movements through parameter space.
 * Validation is done with TypeScript type guards plus explicit numeric/range checks — no schema
 * library, and **no dynamic code evaluation**: nothing here calls `eval`, `Function`, or any
 * equivalent. Imported JSON is treated strictly as data.
 *
 * `validateTrajectoryDocument` throws a `TrajectoryValidationError` whose message names the exact
 * JSON path that failed, so a rejected import is diagnosable rather than a generic "invalid".
 */
import type { GenesisKind, Vec2 } from '../core/types.ts';

/** Unique within one `TrajectoryDocument`. */
export type MovementId = string;

export type PhaseIntention =
  | 'quiet'
  | 'emerge'
  | 'expand'
  | 'connect'
  | 'saturate'
  | 'release';

export type ExitHint = 'living' | 'replicating' | 'connecting' | 'complex' | 'empty';

/** `p` is `[F, k, Du, Dv]`. */
export type WaypointTuple = readonly [number, number, number, number];

export interface WaypointSpec {
  /** Strictly ascending normalized movement time in [0, 1]; endpoints 0 and 1 required. */
  at: number;
  p: WaypointTuple;
}

export interface MovementSpec {
  id: MovementId;
  seconds: number;
  intention: PhaseIntention;
  waypoints: WaypointSpec[];
  /** `next[0]` is the default edge; additional edges are declared recovery alternatives. */
  next: MovementId[];
  enterGenesis?: string;
  exitHint?: ExitHint;
}

export interface GenesisLibraryEntry {
  kind: GenesisKind;
  center: Vec2;
  radiusCells: number;
  strength: number;
}

export interface TrajectoryDocument {
  version: 1;
  id: string;
  seed?: number;
  nominalStepsPerSecond: 120;
  dt: 1;
  durationScaleRange: readonly [number, number];
  parameterJitter: { F: number; k: number; correlationSeconds: number };
  genesisLibrary: Record<string, GenesisLibraryEntry>;
  movements: MovementSpec[];
}

/** §6.2 hard limits and the laboratory safety envelope. */
export const TRAJECTORY_LIMITS = {
  maxMovements: 64,
  maxWaypointsPerMovement: 64,
  maxBytes: 1_048_576, // 1 MiB
  /** `0<=F<=.1`, `0<=k<=.09`, `0<Du,Dv<=.2` — upper bounds here, zero checked separately. */
  paramUpper: { F: 0.1, k: 0.09, Du: 0.2, Dv: 0.2 } as const,
  /** §4.2: `dt * max(Du, Dv) <= .25`. */
  diffusionBound: 0.25,
} as const;

const INTENTIONS: readonly PhaseIntention[] = [
  'quiet',
  'emerge',
  'expand',
  'connect',
  'saturate',
  'release',
];

const EXIT_HINTS: readonly ExitHint[] = [
  'living',
  'replicating',
  'connecting',
  'complex',
  'empty',
];

const GENESIS_KINDS: readonly GenesisKind[] = [
  'single',
  'competing',
  'line',
  'ring',
  'sparse',
  'radial',
  'structured',
];

export class TrajectoryValidationError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'TrajectoryValidationError';
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new TrajectoryValidationError(path, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(path, `expected an object, received ${describe(value)}`);
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, `expected an array, received ${describe(value)}`);
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, `expected a string, received ${describe(value)}`);
  return value;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, `expected a finite number, received ${describe(value)}`);
  }
  return value;
}

/** Reject any key that is not part of the documented shape. */
function requireOnlyKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail(path, `unknown key '${key}'`);
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

function validateParams(p: unknown, path: string): WaypointTuple {
  const tuple = requireArray(p, path);
  if (tuple.length !== 4) fail(path, `expected 4 numbers [F,k,Du,Dv], received ${tuple.length}`);
  const [F, k, Du, Dv] = tuple as [unknown, unknown, unknown, unknown];
  const f = requireFiniteNumber(F, `${path}[0]`);
  const kk = requireFiniteNumber(k, `${path}[1]`);
  const du = requireFiniteNumber(Du, `${path}[2]`);
  const dv = requireFiniteNumber(Dv, `${path}[3]`);

  if (f < 0 || f > TRAJECTORY_LIMITS.paramUpper.F) {
    fail(`${path}[0]`, `F=${f} outside safety envelope [0, ${TRAJECTORY_LIMITS.paramUpper.F}]`);
  }
  if (kk < 0 || kk > TRAJECTORY_LIMITS.paramUpper.k) {
    fail(`${path}[1]`, `k=${kk} outside safety envelope [0, ${TRAJECTORY_LIMITS.paramUpper.k}]`);
  }
  if (du <= 0 || du > TRAJECTORY_LIMITS.paramUpper.Du) {
    fail(`${path}[2]`, `Du=${du} outside safety envelope (0, ${TRAJECTORY_LIMITS.paramUpper.Du}]`);
  }
  if (dv <= 0 || dv > TRAJECTORY_LIMITS.paramUpper.Dv) {
    fail(`${path}[3]`, `Dv=${dv} outside safety envelope (0, ${TRAJECTORY_LIMITS.paramUpper.Dv}]`);
  }

  // §4.2 diffusion stability: dt * max(Du, Dv) <= .25 (dt is fixed at 1 for a trajectory).
  const diffusion = 1 * Math.max(du, dv);
  if (diffusion > TRAJECTORY_LIMITS.diffusionBound + 1e-12) {
    fail(path, `dt*max(Du,Dv)=${diffusion} exceeds diffusion bound ${TRAJECTORY_LIMITS.diffusionBound}`);
  }
  return [f, kk, du, dv];
}

function validateWaypoints(value: unknown, path: string): WaypointSpec[] {
  const array = requireArray(value, path);
  if (array.length < 2) fail(path, `expected at least 2 waypoints (endpoints 0 and 1), received ${array.length}`);
  if (array.length > TRAJECTORY_LIMITS.maxWaypointsPerMovement) {
    fail(path, `expected <= ${TRAJECTORY_LIMITS.maxWaypointsPerMovement} waypoints, received ${array.length}`);
  }
  const result: WaypointSpec[] = [];
  let previousAt = Number.NEGATIVE_INFINITY;
  array.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const object = requireObject(entry, entryPath);
    requireOnlyKeys(object, ['at', 'p'], entryPath);
    const at = requireFiniteNumber(object.at, `${entryPath}.at`);
    if (at < 0 || at > 1) fail(`${entryPath}.at`, `at=${at} outside [0, 1]`);
    if (index === 0 && at !== 0) fail(`${entryPath}.at`, `first waypoint must be at 0, received ${at}`);
    if (index === array.length - 1 && at !== 1) {
      fail(`${entryPath}.at`, `last waypoint must be at 1, received ${at}`);
    }
    if (at <= previousAt) {
      fail(`${entryPath}.at`, `waypoints must be strictly ascending; ${at} is not greater than ${previousAt}`);
    }
    previousAt = at;
    const p = validateParams(object.p, `${entryPath}.p`);
    result.push({ at, p });
  });
  return result;
}

function validateMovement(value: unknown, path: string): MovementSpec {
  const object = requireObject(value, path);
  requireOnlyKeys(object, ['id', 'seconds', 'intention', 'waypoints', 'next', 'enterGenesis', 'exitHint'], path);

  const id = requireString(object.id, `${path}.id`);
  if (id.length === 0) fail(`${path}.id`, 'movement id must not be empty');

  const seconds = requireFiniteNumber(object.seconds, `${path}.seconds`);
  if (seconds <= 0) fail(`${path}.seconds`, `seconds must be > 0, received ${seconds}`);

  const intention = requireString(object.intention, `${path}.intention`);
  if (!INTENTIONS.includes(intention as PhaseIntention)) {
    fail(`${path}.intention`, `unknown intention '${intention}' (expected ${INTENTIONS.join('|')})`);
  }

  const waypoints = validateWaypoints(object.waypoints, `${path}.waypoints`);

  const nextRaw = requireArray(object.next, `${path}.next`);
  if (nextRaw.length === 0) fail(`${path}.next`, 'expected at least one outgoing edge');
  const next: MovementId[] = nextRaw.map((entry, index) =>
    requireString(entry, `${path}.next[${index}]`),
  );

  let enterGenesis: string | undefined;
  if (object.enterGenesis !== undefined) {
    enterGenesis = requireString(object.enterGenesis, `${path}.enterGenesis`);
  }

  let exitHint: ExitHint | undefined;
  if (object.exitHint !== undefined) {
    const hint = requireString(object.exitHint, `${path}.exitHint`);
    if (!EXIT_HINTS.includes(hint as ExitHint)) {
      fail(`${path}.exitHint`, `unknown exitHint '${hint}' (expected ${EXIT_HINTS.join('|')})`);
    }
    exitHint = hint as ExitHint;
  }

  const movement: MovementSpec = {
    id,
    seconds,
    intention: intention as PhaseIntention,
    waypoints,
    next,
  };
  if (enterGenesis !== undefined) movement.enterGenesis = enterGenesis;
  if (exitHint !== undefined) movement.exitHint = exitHint;
  return movement;
}

/**
 * Validate a parsed value as a `TrajectoryDocument`. Throws `TrajectoryValidationError` with a
 * precise path on the first failure.
 */
export function validateTrajectoryDocument(input: unknown): TrajectoryDocument {
  const root = requireObject(input, '$');
  requireOnlyKeys(
    root,
    ['version', 'id', 'seed', 'nominalStepsPerSecond', 'dt', 'durationScaleRange', 'parameterJitter', 'genesisLibrary', 'movements'],
    '$',
  );

  if (root.version !== 1) fail('$.version', `expected version 1, received ${describe(root.version)}`);
  const id = requireString(root.id, '$.id');
  if (id.length === 0) fail('$.id', 'document id must not be empty');

  let seed: number | undefined;
  if (root.seed !== undefined) {
    const value = requireFiniteNumber(root.seed, '$.seed');
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      fail('$.seed', `seed must be a uint32, received ${value}`);
    }
    seed = value >>> 0;
  }

  if (root.nominalStepsPerSecond !== 120) {
    fail('$.nominalStepsPerSecond', `expected 120, received ${describe(root.nominalStepsPerSecond)}`);
  }
  if (root.dt !== 1) fail('$.dt', `expected 1, received ${describe(root.dt)}`);

  const scaleRaw = requireArray(root.durationScaleRange, '$.durationScaleRange');
  if (scaleRaw.length !== 2) fail('$.durationScaleRange', `expected [min, max], received ${scaleRaw.length}`);
  const scaleMin = requireFiniteNumber(scaleRaw[0], '$.durationScaleRange[0]');
  const scaleMax = requireFiniteNumber(scaleRaw[1], '$.durationScaleRange[1]');
  if (!(scaleMin > 0)) fail('$.durationScaleRange[0]', `must be > 0, received ${scaleMin}`);
  if (!(scaleMax >= scaleMin)) fail('$.durationScaleRange[1]', `must be >= min (${scaleMin}), received ${scaleMax}`);

  const jitter = requireObject(root.parameterJitter, '$.parameterJitter');
  requireOnlyKeys(jitter, ['F', 'k', 'correlationSeconds'], '$.parameterJitter');
  const jitterF = requireFiniteNumber(jitter.F, '$.parameterJitter.F');
  const jitterK = requireFiniteNumber(jitter.k, '$.parameterJitter.k');
  if (jitterF < 0) fail('$.parameterJitter.F', `must be >= 0, received ${jitterF}`);
  if (jitterK < 0) fail('$.parameterJitter.k', `must be >= 0, received ${jitterK}`);
  const correlationSeconds = requireFiniteNumber(jitter.correlationSeconds, '$.parameterJitter.correlationSeconds');
  if (correlationSeconds <= 0) {
    fail('$.parameterJitter.correlationSeconds', `must be > 0, received ${correlationSeconds}`);
  }

  const libraryRaw = requireObject(root.genesisLibrary, '$.genesisLibrary');
  const genesisLibrary: Record<string, GenesisLibraryEntry> = {};
  for (const [key, entryValue] of Object.entries(libraryRaw)) {
    const entryPath = `$.genesisLibrary.${key}`;
    const entry = requireObject(entryValue, entryPath);
    requireOnlyKeys(entry, ['kind', 'center', 'radiusCells', 'strength'], entryPath);
    const kind = requireString(entry.kind, `${entryPath}.kind`);
    if (!GENESIS_KINDS.includes(kind as GenesisKind)) {
      fail(`${entryPath}.kind`, `unknown genesis kind '${kind}' (expected ${GENESIS_KINDS.join('|')})`);
    }
    const centerRaw = requireArray(entry.center, `${entryPath}.center`);
    if (centerRaw.length !== 2) fail(`${entryPath}.center`, `expected [u, v], received ${centerRaw.length}`);
    const cu = requireFiniteNumber(centerRaw[0], `${entryPath}.center[0]`);
    const cv = requireFiniteNumber(centerRaw[1], `${entryPath}.center[1]`);
    if (cu < 0 || cu > 1) fail(`${entryPath}.center[0]`, `must be within [0, 1], received ${cu}`);
    if (cv < 0 || cv > 1) fail(`${entryPath}.center[1]`, `must be within [0, 1], received ${cv}`);
    const radiusCells = requireFiniteNumber(entry.radiusCells, `${entryPath}.radiusCells`);
    if (radiusCells <= 0) fail(`${entryPath}.radiusCells`, `must be > 0, received ${radiusCells}`);
    const strength = requireFiniteNumber(entry.strength, `${entryPath}.strength`);
    if (strength < 0 || strength > 1) fail(`${entryPath}.strength`, `must be within [0, 1], received ${strength}`);
    genesisLibrary[key] = { kind: kind as GenesisKind, center: [cu, cv], radiusCells, strength };
  }

  const movementsRaw = requireArray(root.movements, '$.movements');
  if (movementsRaw.length === 0) fail('$.movements', 'expected at least one movement');
  if (movementsRaw.length > TRAJECTORY_LIMITS.maxMovements) {
    fail('$.movements', `expected <= ${TRAJECTORY_LIMITS.maxMovements} movements, received ${movementsRaw.length}`);
  }
  const movements = movementsRaw.map((entry, index) => validateMovement(entry, `$.movements[${index}]`));

  // Unique IDs.
  const idSet = new Set<string>();
  movements.forEach((movement, index) => {
    if (idSet.has(movement.id)) fail(`$.movements[${index}].id`, `duplicate movement id '${movement.id}'`);
    idSet.add(movement.id);
  });

  // Resolvable edges and genesis references.
  movements.forEach((movement, index) => {
    movement.next.forEach((edge, edgeIndex) => {
      if (!idSet.has(edge)) {
        fail(`$.movements[${index}].next[${edgeIndex}]`, `unresolvable movement reference '${edge}'`);
      }
    });
    if (movement.enterGenesis !== undefined && !(movement.enterGenesis in genesisLibrary)) {
      fail(
        `$.movements[${index}].enterGenesis`,
        `unresolvable genesis reference '${movement.enterGenesis}'`,
      );
    }
  });

  const document: TrajectoryDocument = {
    version: 1,
    id,
    nominalStepsPerSecond: 120,
    dt: 1,
    durationScaleRange: [scaleMin, scaleMax],
    parameterJitter: { F: jitterF, k: jitterK, correlationSeconds },
    genesisLibrary,
    movements,
  };
  if (seed !== undefined) document.seed = seed;
  return document;
}

/** UTF-8 byte length of a JSON text (the §6.2 `<= 1 MB` import guard). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1; // surrogate pair
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Parse and validate a trajectory JSON string. Enforces the §6.2 1 MiB import bound before
 * parsing. Never evaluates the text.
 */
export function parseTrajectoryDocument(text: string): TrajectoryDocument {
  const bytes = utf8ByteLength(text);
  if (bytes > TRAJECTORY_LIMITS.maxBytes) {
    fail('$', `import is ${bytes} bytes, exceeding the ${TRAJECTORY_LIMITS.maxBytes}-byte limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail('$', `not valid JSON (${(error as Error).message})`);
  }
  return validateTrajectoryDocument(parsed);
}

/** Serialize a validated document for export (round-trips through `parseTrajectoryDocument`). */
export function serializeTrajectoryDocument(document: TrajectoryDocument): string {
  return JSON.stringify(document, null, 2);
}
