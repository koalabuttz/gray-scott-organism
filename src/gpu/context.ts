/**
 * §2.1 Context creation and capability verification.
 *
 * The artwork requests WebGL2 with `alpha:false, antialias:false, depth:false, stencil:false,
 * preserveDrawingBuffer:false` (it creates its own depth attachment), requires
 * `EXT_color_buffer_float`, and validates actual framebuffer completeness — plus a real render
 * probe — for every format the pipeline depends on. Any silent downgrade is refused: if a
 * required format cannot be rendered to, the app reports a capability failure rather than
 * falling back to packed byte chemistry (§13 risk table).
 *
 * The render probe writes a known constant into the candidate format and then *samples* it back
 * through an RGBA8 resolve target. It must work that way: reading a half-float attachment with
 * `readPixels(RGBA, FLOAT)` is rejected by ANGLE ("Invalid format and type combination"), and
 * the probe should in any case verify the operation the pipeline actually performs — render to a
 * float format and read it in a shader.
 */

export interface FormatCheck {
  name: string;
  internalFormatName: string;
  attachment: 'color' | 'depth';
  complete: boolean;
  status: string;
  /** For colour formats: a known value was rendered, sampled back and matched. */
  writeVerified: boolean;
  writeError: string | null;
}

export interface ImplementationColorRead {
  format: number;
  type: number;
  formatName: string;
  typeName: string;
}

export interface CapabilityReport {
  ok: boolean;
  createdAt: string;
  userAgent: string;
  vendor: string;
  renderer: string;
  unmaskedRendererSupported: boolean;
  glVersion: string;
  glslVersion: string;
  softwareRenderer: boolean;
  extensions: Record<string, boolean>;
  limits: Record<string, number>;
  implementationColorRead: ImplementationColorRead;
  contextAttributes: {
    alpha: boolean;
    antialias: boolean;
    depth: boolean;
    stencil: boolean;
    preserveDrawingBuffer: boolean;
    powerPreference: string;
  };
  formats: FormatCheck[];
  problems: string[];
}

/** A renderer whose name indicates a software rasteriser rather than the target GPU. */
const SOFTWARE_PATTERN =
  /swiftshader|llvmpipe|softpipe|software|lavapipe|mesa offscreen|angle \(google, vulkan.*swiftshader/i;

export interface GpuContext {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  report: CapabilityReport;
}

export class CapabilityError extends Error {
  readonly report: CapabilityReport | null;
  constructor(message: string, report: CapabilityReport | null = null) {
    super(message);
    this.name = 'CapabilityError';
    this.report = report;
  }
}

const REQUIRED_EXTENSIONS = ['EXT_color_buffer_float'] as const;
const OPTIONAL_EXTENSIONS = [
  'WEBGL_debug_renderer_info',
  'OES_texture_float_linear',
  'EXT_disjoint_timer_query_webgl2',
  'WEBGL_lose_context',
  'EXT_color_buffer_half_float',
] as const;

const REQUIRED_LIMITS = [
  'MAX_TEXTURE_SIZE',
  'MAX_RENDERBUFFER_SIZE',
  'MAX_TEXTURE_IMAGE_UNITS',
  'MAX_VERTEX_TEXTURE_IMAGE_UNITS',
  'MAX_FRAGMENT_UNIFORM_VECTORS',
  'MAX_VERTEX_UNIFORM_VECTORS',
  'MAX_ARRAY_TEXTURE_LAYERS',
] as const;

export function createContext(canvas: HTMLCanvasElement): GpuContext {
  const attributes: WebGLContextAttributes = {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
    desynchronized: false,
  };
  const gl = canvas.getContext('webgl2', attributes) as WebGL2RenderingContext | null;
  if (!gl) {
    throw new CapabilityError(
      'WebGL2 is unavailable. The artwork requires WebGL2 with EXT_color_buffer_float for ' +
        'floating-point reaction-diffusion fields.',
    );
  }

  const report = buildReport(gl, attributes);
  if (!report.ok) {
    throw new CapabilityError(
      `GPU capability check failed: ${report.problems.join('; ')}`,
      report,
    );
  }
  return { gl, canvas, report };
}

export function buildReport(
  gl: WebGL2RenderingContext,
  attributes: WebGLContextAttributes,
): CapabilityReport {
  const problems: string[] = [];

  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const vendor = debugInfo
    ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL))
    : String(gl.getParameter(gl.VENDOR));
  const renderer = debugInfo
    ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
    : String(gl.getParameter(gl.RENDERER));

  const extensions: Record<string, boolean> = {};
  for (const name of REQUIRED_EXTENSIONS) {
    extensions[name] = !!gl.getExtension(name);
    if (!extensions[name]) {
      problems.push(`required extension ${name} is unavailable`);
    }
  }
  for (const name of OPTIONAL_EXTENSIONS) {
    extensions[name] = !!gl.getExtension(name);
  }

  const limits: Record<string, number> = {};
  for (const name of REQUIRED_LIMITS) {
    const value = gl.getParameter(gl[name] as number);
    limits[name] = typeof value === 'number' ? value : -1;
  }
  const viewportDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null;
  if (viewportDims) {
    limits['MAX_VIEWPORT_WIDTH'] = viewportDims[0]!;
    limits['MAX_VIEWPORT_HEIGHT'] = viewportDims[1]!;
  }
  if (limits['MAX_VERTEX_TEXTURE_IMAGE_UNITS'] !== undefined && limits['MAX_VERTEX_TEXTURE_IMAGE_UNITS'] < 1) {
    problems.push('no vertex texture image units: the displaced sheet vertex shader cannot sample height');
  }

  const formats = probeRenderTargets(gl);
  for (const format of formats.checks) {
    if (!format.complete) {
      problems.push(`framebuffer for ${format.name} is incomplete (${format.status})`);
    } else if (format.attachment === 'color' && !format.writeVerified) {
      problems.push(
        `render target ${format.name} is complete but a render probe failed: ${format.writeError ?? 'unknown'}`,
      );
    }
  }
  // A probe shader that will not compile is a capability problem in its own right: without it the
  // probe results (and therefore the format verification) mean nothing.
  for (const error of formats.errors) problems.push(`probe shader problem: ${error}`);

  const softwareRenderer = SOFTWARE_PATTERN.test(renderer);

  const actual = gl.getContextAttributes();
  return {
    ok: problems.length === 0,
    createdAt: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    vendor,
    renderer,
    unmaskedRendererSupported: !!debugInfo,
    glVersion: String(gl.getParameter(gl.VERSION)),
    glslVersion: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),
    softwareRenderer,
    extensions,
    limits,
    implementationColorRead: {
      format: gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) as number,
      type: gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) as number,
      formatName: glEnumName(gl, gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) as number),
      typeName: glEnumName(gl, gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) as number),
    },
    contextAttributes: {
      alpha: !!actual?.alpha,
      antialias: !!actual?.antialias,
      depth: !!actual?.depth,
      stencil: !!actual?.stencil,
      preserveDrawingBuffer: !!actual?.preserveDrawingBuffer,
      powerPreference: String(attributes.powerPreference ?? 'default'),
    },
    formats: formats.checks,
    problems,
  };
}

interface FormatSpec {
  name: string;
  internalFormat: number;
  internalFormatName: string;
  format: number;
  type: number;
  attachment: 'color' | 'depth';
  /** Integer render targets need an integer-writing probe program and an integer readback. */
  integer?: boolean;
  /** Expected RGBA8 bytes after rendering (0.5, 0.25, 0.75, 1) into this format. */
  expectedBytes?: readonly [number, number, number];
}

/**
 * Create each required attachment, attach it, check completeness, then render a known constant
 * into it and resolve it through an RGBA8 target to prove the format is genuinely renderable and
 * samplable. Half-float and float32 attachments are never read back numerically here.
 */
export function probeRenderTargets(gl: WebGL2RenderingContext): {
  checks: FormatCheck[];
  errors: string[];
} {
  const specs: FormatSpec[] = [
    {
      name: 'RG32F',
      internalFormat: gl.RG32F,
      internalFormatName: 'RG32F',
      format: gl.RG,
      type: gl.FLOAT,
      attachment: 'color',
      // An RG32F attachment stores only (R, G): B resolves to 0 by construction.
      expectedBytes: [128, 64, 0],
    },
    {
      name: 'RGBA16F',
      internalFormat: gl.RGBA16F,
      internalFormatName: 'RGBA16F',
      format: gl.RGBA,
      type: gl.HALF_FLOAT,
      attachment: 'color',
      expectedBytes: [128, 64, 191],
    },
    {
      name: 'RGBA8',
      internalFormat: gl.RGBA8,
      internalFormatName: 'RGBA8',
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      attachment: 'color',
      expectedBytes: [128, 64, 191],
    },
    {
      name: 'DEPTH_COMPONENT24',
      internalFormat: gl.DEPTH_COMPONENT24,
      internalFormatName: 'DEPTH_COMPONENT24',
      format: gl.DEPTH_COMPONENT,
      type: gl.UNSIGNED_INT,
      attachment: 'depth',
    },
    {
      // Used by the validation-only pre-clamp instrumentation (AC.5) to accumulate exact integer
      // clip counts. Colour-renderable in WebGL2 core, but verified here rather than assumed.
      name: 'RGBA32UI',
      internalFormat: gl.RGBA32UI,
      internalFormatName: 'RGBA32UI',
      format: gl.RGBA_INTEGER,
      type: gl.UNSIGNED_INT,
      attachment: 'color',
      integer: true,
      expectedBytes: [128, 64, 191],
    },
  ];

  const checks: FormatCheck[] = [];
  const size = 4;
  const floatWrite = compileProgram(gl, WRITE_PROBE_FRAGMENT);
  const integerWrite = compileProgram(gl, WRITE_PROBE_INTEGER_FRAGMENT);
  const floatCopy = compileProgram(gl, COPY_PROBE_FRAGMENT);
  const integerCopy = compileProgram(gl, COPY_PROBE_INTEGER_FRAGMENT);
  const probePrograms: ProbePrograms = {
    writeFloat: floatWrite.program,
    writeInteger: integerWrite.program,
    copyFloat: floatCopy.program,
    copyInteger: integerCopy.program,
  };
  const errors = [floatWrite.error, integerWrite.error, floatCopy.error, integerCopy.error].filter(
    (error): error is string => typeof error === 'string' && error.length > 0,
  );
  const resolveTarget = createProbeTarget(gl, size, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);

  for (const spec of specs) {
    const previousFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    let writeVerified = false;
    let writeError: string | null = null;
    let statusName = 'unknown';
    let complete = false;

    try {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, spec.internalFormat, size, size);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      if (spec.attachment === 'color') {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      } else {
        const color = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, color);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, size, size);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texture, 0);
        gl.deleteTexture(color);
      }
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      complete = status === gl.FRAMEBUFFER_COMPLETE;
      statusName = framebufferStatusName(gl, status);

      if (complete && spec.attachment === 'color' && resolveTarget) {
        const result = renderProbe(gl, probePrograms, resolveTarget, texture, size, spec);
        writeVerified = result.ok;
        writeError = result.error;
      } else if (spec.attachment === 'depth' && complete) {
        writeVerified = true; // nothing to read back from a depth attachment
      }
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, previousFbo);
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
    }

    checks.push({
      name: spec.name,
      internalFormatName: spec.internalFormatName,
      attachment: spec.attachment,
      complete,
      status: statusName,
      writeVerified,
      writeError,
    });
  }

  for (const program of [
    probePrograms.writeFloat,
    probePrograms.writeInteger,
    probePrograms.copyFloat,
    probePrograms.copyInteger,
  ]) {
    if (program) gl.deleteProgram(program);
  }
  if (resolveTarget) {
    gl.deleteFramebuffer(resolveTarget.framebuffer);
    gl.deleteTexture(resolveTarget.texture);
  }
  return { checks, errors };
}

interface ProbeTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

function createProbeTarget(
  gl: WebGL2RenderingContext,
  size: number,
  internalFormat: number,
  format: number,
  type: number,
): ProbeTarget | null {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, size, size);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    return null;
  }
  void format;
  void type;
  return { texture, framebuffer };
}

interface ProbePrograms {
  writeFloat: WebGLProgram | null;
  writeInteger: WebGLProgram | null;
  copyFloat: WebGLProgram | null;
  copyInteger: WebGLProgram | null;
}

function renderProbe(
  gl: WebGL2RenderingContext,
  programs: ProbePrograms,
  resolveTarget: ProbeTarget,
  source: WebGLTexture,
  size: number,
  spec: FormatSpec,
): { ok: boolean; error: string | null } {
  const tolerance = 2;
  const writeProgram = spec.integer ? programs.writeInteger : programs.writeFloat;
  const copyProgram = spec.integer ? programs.copyInteger : programs.copyFloat;
  if (!writeProgram || !copyProgram) {
    return { ok: false, error: 'probe programs failed to link' };
  }
  try {
    // 1. render the constant into the candidate format, still bound from the completeness check
    gl.viewport(0, 0, size, size);
    gl.useProgram(writeProgram);
    if (spec.integer) {
      gl.uniform4ui(gl.getUniformLocation(writeProgram, 'uValueUint'), 128, 64, 191, 255);
    } else {
      gl.uniform4f(gl.getUniformLocation(writeProgram, 'uValue'), 0.5, 0.25, 0.75, 1);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const writeError = gl.getError();
    if (writeError !== gl.NO_ERROR) {
      return { ok: false, error: `gl.getError() = 0x${writeError.toString(16)} rendering into ${spec.name}` };
    }

    // 2. sample it back through an RGBA8 resolve target
    gl.bindFramebuffer(gl.FRAMEBUFFER, resolveTarget.framebuffer);
    gl.viewport(0, 0, size, size);
    gl.useProgram(copyProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform1i(gl.getUniformLocation(copyProgram, 'uSource'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const copyError = gl.getError();
    if (copyError !== gl.NO_ERROR) {
      return { ok: false, error: `gl.getError() = 0x${copyError.toString(16)} sampling ${spec.name}` };
    }

    const out = new Uint8Array(size * size * 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, out);
    const readError = gl.getError();
    if (readError !== gl.NO_ERROR) {
      return { ok: false, error: `readPixels from the resolve target failed (0x${readError.toString(16)})` };
    }

    const expected = spec.expectedBytes ?? [128, 64, 191];
    const ok = expected.every((value, index) => Math.abs(out[index]! - value) <= tolerance);
    return {
      ok,
      error: ok
        ? null
        : `resolved [${out[0]}, ${out[1]}, ${out[2]}], expected [${expected.join(', ')}]`,
    };
  } catch (cause) {
    return { ok: false, error: `probe threw: ${String(cause)}` };
  }
}

const PROBE_VERTEX = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const WRITE_PROBE_FRAGMENT = `#version 300 es
precision highp float;
uniform vec4 uValue;
out vec4 outColor;
void main() { outColor = uValue; }`;

const WRITE_PROBE_INTEGER_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform uvec4 uValueUint;
layout(location = 0) out uvec4 outColor;
void main() { outColor = uValueUint; }`;

const COPY_PROBE_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uSource;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 sampled = texture(uSource, vUv).rgb;
  outColor = vec4(sampled, 1.0);
}`;

/** Integer attachments must be sampled with an integer sampler and scaled before resolving. */
const COPY_PROBE_INTEGER_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D uSource;
in vec2 vUv;
out vec4 outColor;
void main() {
  uvec3 sampled = texture(uSource, vUv).rgb;
  outColor = vec4(vec3(sampled) / 255.0, 1.0);
}`;

function compileProgram(
  gl: WebGL2RenderingContext,
  fragmentSource: string,
): { program: WebGLProgram | null; error: string | null } {
  const vertex = gl.createShader(gl.VERTEX_SHADER);
  const fragment = gl.createShader(gl.FRAGMENT_SHADER);
  if (!vertex || !fragment) return { program: null, error: 'createShader failed' };
  const compile = (shader: WebGLShader, source: string, label: string): string | null => {
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      return `${label} compile failed: ${gl.getShaderInfoLog(shader) ?? ''}`;
    }
    return null;
  };
  const vertexError = compile(vertex, PROBE_VERTEX, 'probe vertex');
  const fragmentError = compile(fragment, fragmentSource, 'probe fragment');
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    return { program: null, error: 'createProgram failed' };
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
  const linkLog = String(gl.getProgramInfoLog(program) ?? '');
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!linked) {
    gl.deleteProgram(program);
    return {
      program: null,
      error: [vertexError, fragmentError, `link failed: ${linkLog}`].filter(Boolean).join(' | '),
    };
  }
  return { program, error: vertexError ?? fragmentError };
}

export function framebufferStatusName(gl: WebGL2RenderingContext, status: number): string {
  switch (status) {
    case gl.FRAMEBUFFER_COMPLETE:
      return 'FRAMEBUFFER_COMPLETE';
    case gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT:
      return 'FRAMEBUFFER_INCOMPLETE_ATTACHMENT';
    case gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT:
      return 'FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT';
    case gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS:
      return 'FRAMEBUFFER_INCOMPLETE_DIMENSIONS';
    case gl.FRAMEBUFFER_UNSUPPORTED:
      return 'FRAMEBUFFER_UNSUPPORTED';
    case gl.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE:
      return 'FRAMEBUFFER_INCOMPLETE_MULTISAMPLE';
    default:
      return `unknown(0x${status.toString(16)})`;
  }
}

/** Names a handful of enums for the report; unknown values fall back to hex. */
export function glEnumName(gl: WebGL2RenderingContext, value: number): string {
  const table: Record<number, string> = {
    [gl.UNSIGNED_BYTE]: 'UNSIGNED_BYTE',
    [gl.UNSIGNED_SHORT]: 'UNSIGNED_SHORT',
    [gl.UNSIGNED_INT]: 'UNSIGNED_INT',
    [gl.FLOAT]: 'FLOAT',
    [gl.HALF_FLOAT]: 'HALF_FLOAT',
    [gl.RGBA]: 'RGBA',
    [gl.RGB]: 'RGB',
    [gl.RG]: 'RG',
    [gl.RED]: 'RED',
    [gl.RGBA_INTEGER ?? -1]: 'RGBA_INTEGER',
  };
  const name = table[value];
  if (name) return name;
  const candidates: Array<[string, number]> = [
    ['UNSIGNED_INT_2_10_10_10_REV', gl.UNSIGNED_INT_2_10_10_10_REV],
    ['FLOAT_32_UNSIGNED_INT_24_8_REV', gl.FLOAT_32_UNSIGNED_INT_24_8_REV],
  ];
  for (const [label, enumValue] of candidates) {
    if (enumValue === value) return label;
  }
  return `0x${value.toString(16)}`;
}

/** Human-readable capability report for `artifacts/capability-report.md`. */
export function capabilityReportMarkdown(report: CapabilityReport): string {
  const lines: string[] = [];
  lines.push('# Capability report — An Organism in Darkness (Phase 1)');
  lines.push('');
  lines.push(`Generated: ${report.createdAt}`);
  lines.push('');
  lines.push(`Overall: ${report.ok ? '**PASS**' : '**FAIL**'}`);
  lines.push('');
  lines.push('## Renderer');
  lines.push('');
  lines.push(`- Unmasked renderer: \`${report.renderer}\``);
  lines.push(`- Unmasked vendor: \`${report.vendor}\``);
  lines.push(`- Renderer is a software rasteriser: **${report.softwareRenderer}**`);
  lines.push(`- WEBGL_debug_renderer_info available: ${report.unmaskedRendererSupported}`);
  lines.push(`- WebGL version: \`${report.glVersion}\``);
  lines.push(`- GLSL version: \`${report.glslVersion}\``);
  lines.push(`- User agent: \`${report.userAgent}\``);
  lines.push(
    `- IMPLEMENTATION_COLOR_READ_FORMAT/TYPE: ${report.implementationColorRead.formatName} / ${report.implementationColorRead.typeName}`,
  );
  lines.push('- Measured throughput evidence: `artifacts/phase1-performance.json` (measured pipeline cost and solver throughput; see §11.1 of architecture-plan.md)');
  lines.push('');
  lines.push('## Context attributes actually granted');
  lines.push('');
  for (const [key, value] of Object.entries(report.contextAttributes)) {
    lines.push(`- ${key}: \`${String(value)}\``);
  }
  lines.push('');
  lines.push('## Extensions');
  lines.push('');
  for (const [key, value] of Object.entries(report.extensions)) {
    lines.push(`- ${key}: ${value ? 'present' : 'absent'}`);
  }
  lines.push('');
  lines.push('## Limits');
  lines.push('');
  for (const [key, value] of Object.entries(report.limits)) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push('');
  lines.push('## Framebuffer format validation');
  lines.push('');
  lines.push('| Format | Attachment | Complete | Status | Render + sample probe |');
  lines.push('|---|---|---|---|---|');
  for (const format of report.formats) {
    const probe = format.attachment === 'depth'
      ? 'n/a (depth)'
      : format.writeVerified
        ? 'pass'
        : `FAIL: ${format.writeError ?? 'unknown'}`;
    lines.push(
      `| ${format.name} | ${format.attachment} | ${format.complete ? 'yes' : 'no'} | ${format.status} | ${probe} |`,
    );
  }
  lines.push('');
  lines.push(
    'The probe renders `(0.5, 0.25, 0.75, 1)` into each colour format and resolves it through an',
  );
  lines.push(
    'RGBA8 target, so it verifies rendering *and* sampling rather than completeness alone. RG32F',
  );
  lines.push('stores two channels, so its resolved blue is 0 by construction.');
  lines.push('');
  if (report.problems.length > 0) {
    lines.push('## Problems');
    lines.push('');
    for (const problem of report.problems) lines.push(`- ${problem}`);
    lines.push('');
  } else {
    lines.push('No capability problems detected.');
    lines.push('');
  }
  return lines.join('\n');
}
