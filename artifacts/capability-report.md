# Capability report — An Organism in Darkness (Phase 1)

Generated: 2026-09-21T06:03:42.013Z

Overall: **PASS**

## Renderer

- Unmasked renderer: `ANGLE (Intel, Vulkan 1.4.305 (Intel(R) Graphics (RPL-U) (0x0000A7A9)), Intel open-source Mesa driver)`
- Unmasked vendor: `Google Inc. (Intel)`
- Renderer is a software rasteriser: **false**
- WEBGL_debug_renderer_info available: true
- WebGL version: `WebGL 2.0 (OpenGL ES 3.0 Chromium)`
- GLSL version: `WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)`
- User agent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36`
- IMPLEMENTATION_COLOR_READ_FORMAT/TYPE: RGBA / UNSIGNED_BYTE
- Measured throughput evidence: `artifacts/phase1-performance.json` (measured pipeline cost and solver throughput; see §11.1 of architecture-plan.md)

## Context attributes actually granted

- alpha: `false`
- antialias: `false`
- depth: `false`
- stencil: `false`
- preserveDrawingBuffer: `false`
- powerPreference: `high-performance`

## Extensions

- EXT_color_buffer_float: present
- WEBGL_debug_renderer_info: present
- OES_texture_float_linear: present
- EXT_disjoint_timer_query_webgl2: present
- WEBGL_lose_context: present
- EXT_color_buffer_half_float: present

## Limits

- MAX_TEXTURE_SIZE: 16384
- MAX_RENDERBUFFER_SIZE: 16384
- MAX_TEXTURE_IMAGE_UNITS: 32
- MAX_VERTEX_TEXTURE_IMAGE_UNITS: 32
- MAX_FRAGMENT_UNIFORM_VECTORS: 4096
- MAX_VERTEX_UNIFORM_VECTORS: 4096
- MAX_ARRAY_TEXTURE_LAYERS: 2048
- MAX_VIEWPORT_WIDTH: 16384
- MAX_VIEWPORT_HEIGHT: 16384

## Framebuffer format validation

| Format | Attachment | Complete | Status | Render + sample probe |
|---|---|---|---|---|
| RG32F | color | yes | FRAMEBUFFER_COMPLETE | pass |
| RGBA16F | color | yes | FRAMEBUFFER_COMPLETE | pass |
| RGBA8 | color | yes | FRAMEBUFFER_COMPLETE | pass |
| DEPTH_COMPONENT24 | depth | yes | FRAMEBUFFER_COMPLETE | n/a (depth) |
| RGBA32UI | color | yes | FRAMEBUFFER_COMPLETE | pass |

The probe renders `(0.5, 0.25, 0.75, 1)` into each colour format and resolves it through an
RGBA8 target, so it verifies rendering *and* sampling rather than completeness alone. RG32F
stores two channels, so its resolved blue is 0 by construction.

No capability problems detected.


## Test harness

- Playwright project: `headless-gpu`
- Mode: headless (Chromium new headless through the `chromium` channel) — no window is created, so a test run cannot take foreground focus
- Launch arguments: `--no-sandbox --disable-dev-shm-usage --ignore-gpu-blocklist --enable-unsafe-swiftshader --use-angle=vulkan`
- Renderer reached by this run: `ANGLE (Intel, Vulkan 1.4.305 (Intel(R) Graphics (RPL-U) (0x0000A7A9)), Intel open-source Mesa driver)`
- Software rasteriser: **false**
- `EXT_color_buffer_float` present in this run: **true**
- The default suite (`npm run test:browser`) runs the headless project; a headless run on this
  machine still reaches the real GPU because ANGLE's Vulkan backend drives the Intel device
  through the DRI render node. The old headless shell has no such path and falls back to
  SwiftShader, which is why the `chromium` channel is required rather than assumed.
- Reference readings from a headed run on the same machine (ANGLE + Mesa GL-ES path, the
  operator's actual presentation path): `ANGLE (Intel, Mesa Intel(R) Graphics (RPL-U),
  OpenGL ES 3.2)` with the same format results. The two paths agree on every assertion in this
  report; the renderer strings differ, which is why both are recorded.
