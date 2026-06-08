# Brain Atlas WebGL2 Renderer — Design

**Date:** 2026-06-03
**Issue:** [#2 — Stunning 3D view! (But it's cooking my CPU)](https://github.com/colorpulse6/brain-atlas/issues/2)
**Status:** Implemented in 0.2.0. Describes the renderer architecture and the fidelity strategy that keeps WebGL2 output identical to the Canvas2D reference.

## Problem

The current `src/renderer.ts` does all 3D work on the CPU main thread every frame. At
default caps (`nodeCap: 1500`, `edgeCap: 4000`, cloud ≈ 1648 points) a single frame performs
roughly:

- **~52,000 projections** — 4000 edges × 13 Bézier sample points each, every point a fresh
  object allocation, plus 1648 cloud projections and ~1500 node projections.
- **~48,000 separate `stroke()` calls** — 4000 edges × 12 segments, each a distinct
  `beginPath/moveTo/lineTo/stroke` because color and alpha vary per segment.
- **Thousands of RGBA color-string allocations** — `hexA()` runs `parseInt(…,16)` three times
  and builds a new `rgba(...)` string on every call (≈48k just for edge segments), churning the
  garbage collector.
- **~1500 `createRadialGradient()` calls** for node halos.

Because the view idle-auto-rotates, this runs continuously at the frame cap even when the user
is not interacting, which is why the reporter saw the CPU pegged "just idling on the graph."

## Goal

Move the desktop geometry pipeline to the GPU via a hand-rolled WebGL2 renderer, eliminating
per-frame CPU projection, the 48k per-segment strokes, and the per-frame color-string
allocations — **with no visible change to the rendered output.** Visual identity is a hard
requirement. The current Canvas2D renderer is retained as the canonical reference and as the
runtime fallback (see Architecture), so "no visible change" is verifiable by toggling between
the two paths.

Note: the WebGL path must reproduce the current output **exactly, including its quantized
artifacts** — e.g. the per-segment constant alpha (a stair-step along each edge) and the hard
mid-edge color switch. GPU-smooth interpolation of those would be *different*, not faithful, and
is therefore explicitly disallowed (see Fidelity Strategy).

## Non-Goals

- No three.js or any rendering dependency. Hand-rolled WebGL2 keeps the bundle small and the
  source reviewable per Obsidian policy (no obfuscation, no blobs). Zero new runtime deps.
- No WebGPU. Not reliably available in Obsidian's Electron/mobile runtimes yet.
- No change to privacy/network posture. WebGL runs entirely on the user's own GPU. No server,
  no account, no dependency. "Local-only rendering" stays true verbatim.
- No changes to `adapter.ts`, `classify.ts`, `palette.ts`, `shape.ts` math, or the settings
  schema beyond the already-in-flight Mobile preset work and the new `rendererMode` override.
- Not removing the Canvas2D renderer — it remains the fallback (see below).

## Architecture

### Renderer selection (dual renderer)

The view picks a renderer at startup:

- **WebGL2 path** when *not* a mobile runtime **and** a `webgl2` context is successfully
  created. This is the desktop default and the target of issue #2.
- **Canvas2D path** (the existing `renderer.ts`, refactored — see below) when the runtime is
  mobile (`isMobileRuntime()`, already added by the in-flight Mobile preset work) **or** WebGL2
  context creation fails / is lost. The Mobile preset (DPR = 1, 15 fps idle pacing, reduced
  label caps) exists precisely to tune this path on constrained devices.

Rationale: WebGL2 on Obsidian mobile (WKWebView / Android WebView) is unreliable — contexts are
evicted on backgrounding and memory pressure. Mobile keeping the proven Canvas2D path avoids
regressing the plugin's advertised (experimental) mobile support, while desktop gets the GPU
win. `manifest.json` stays `isDesktopOnly: false`.

### Shared base (`src/render-core.ts`)

Both renderers share everything that is not "how pixels get drawn." Extract from today's
`renderer.ts` into a base class/module used by both:

- Pointer interaction (rotate/node-drag/zoom/contextmenu-reset), the 3px move threshold,
  `setPointerCapture`/`localPoint` rect math, click suppression.
- Frame scheduling (`requestImmediateFrame`, `scheduleNextFrame`, `nextFrameDelay`,
  `effectivePerformancePreset`, `PERFORMANCE_FRAME_DELAYS`) and DPR cap (`maxDevicePixelRatio`).
- Idle auto-rotate (`rot.y += 0.00065` after 1800 ms idle).
- Hit-testing (`hitTestProjected`, `hitTolerance`, the `z > 0.4` cull) against a CPU
  `projCache` of node screen positions, computed each frame with `makeProjector`.
- Signal spawning (`spawnSignals`) and the signal list.
- Lobe stats, options plumbing (`setOptions`, `setHighlightLobe`), the public surface
  (`getHoveredNode`, `getFocusedNode`, `getLobeStats`, `hitTest`, `consumeSuppressedClick`).

Each renderer implements only `drawScene()` (the per-frame draw) and buffer/state management.
The base keeps `view.ts` interaction wiring unchanged in behavior.

**Determinism seams (for fidelity testing).** Both renderers must support rendering one
reproducible frame: an injectable clock (`draw(now)` already takes time), a `deterministic`
flag that disables idle auto-rotate and signal spawning (signals use `Math.random()`), and an
explicit `setView({rot, zoom, dpr})` so a harness can fix camera + DPR. With these, the same
inputs produce byte-stable geometry, which is what the A/B pixel-diff (below) relies on.

### WebGL path — two stacked canvases

The WebGL path uses two same-sized canvases inside the view container, owned by the renderer:

1. **WebGL2 canvas (bottom)** renders everything that blends against the background:
   background gradient, lobe haze, point cloud, edges, node halos + cores, signals.
2. **Canvas2D overlay (top, transparent, `pointer-events: none`)** renders only what is drawn
   dead-last today with plain source-over compositing: node labels + black backplates, lobe
   labels/dots/lead-lines, and the compass. This reuses the existing label/compass drawing code
   **verbatim (no numeric changes)**.

Z-stacking: WebGL canvas (z 0) under the overlay canvas (z 1) under the existing HUD/legend DOM
(z 2). All pointer/wheel/contextmenu/click listeners attach to the **WebGL (bottom) canvas**;
the overlay is `pointer-events: none` so events reach it.

**Canvas ownership (both paths).** Today `view.ts` creates a single `.brain-atlas-canvas` and
passes it to `renderer.start(canvas, …)`, and `view.ts` reaches into `this.canvas` directly for
`onCanvasClick` rect math and the `click` listener. In the dual model, the **view passes its
container element** and the renderer creates/owns its canvas(es): the Canvas2D renderer makes one
canvas; the WebGL renderer makes the WebGL + overlay pair. `view.ts`'s click/rect logic must use
the renderer's event-receiving (bottom) canvas — expose it via the shared base (e.g.
`renderer.getInteractionTarget()`) so `onCanvasClick`'s `getBoundingClientRect` and `localPoint`
repoint there. This is a real `view.ts` contract change (not "minimal"); only the interaction
*behavior* is unchanged.

### Why the two-canvas split is fidelity-preserving (critical)

`globalCompositeOperation = "lighter"` (additive) for cloud/haze/signals adds the source color
onto whatever is already in the canvas — **including the background and haze.** Moving any
additive element to a separate transparent canvas would make it add onto transparent and then
composite over the background — a different, wrong result. Therefore **everything
additive-or-over-background shares one canvas** (→ WebGL, background and haze included). Only
elements drawn dead-last with plain source-over may live on the overlay, because compositing a
transparent overlay onto the result with source-over is mathematically identical to drawing
those elements last in one canvas. The current draw order already draws labels and the compass
last, so the split is provably faithful.

### Rejected approaches

- **Full WebGL incl. text via a glyph atlas.** More code, real risk of text differing from
  native `fillText`, no meaningful gain (labels are cheap). Keep text on the Canvas2D overlay.
- **`gl.POINTS` / `gl.LINES` primitives.** Point/line AA and line width are driver-dependent and
  will not match Canvas2D's smooth circles/strokes. Use point-sprite quads / triangle-strip
  ribbons with analytic in-shader coverage instead (see Fidelity Strategy).

## Components / Files

- **`src/render-core.ts`** — shared base (interaction, scheduling, hit-test, signals, options).
- **`src/renderer.ts`** — existing Canvas2D renderer, refactored to extend/use `render-core`.
  Retained as the canonical reference and the fallback path. Frame-pacing and label-gating
  logic moves to the base; keep behavior identical.
- **`src/gl/brain-gl-renderer.ts`** — the WebGL2 renderer. Same public surface; owns two
  canvases; implements `drawScene()` and buffer management.
- **`src/gl/shaders.ts`** — vertex/fragment shader source strings (inline, reviewable).
- **`src/gl/programs.ts`** — minimal compile/link/uniform/attribute helpers (~80 lines, no deps).
- **`src/gl/buffers.ts`** — pure functions that build vertex arrays (positions, ribbon vertices,
  cloud, per-vertex color/index attributes) from the graph. No GL calls → unit-testable.
- **`src/gl/projection.ts`** — pure function producing the projection inputs and the
  `{sx,sy,z,scale,depth}` math, kept numerically locked to `makeProjector` (see Testing).

## Data Flow — static buffers, per-frame uniforms, dynamic geometry

The win comes from not re-projecting/re-coloring on the CPU each frame. But several visual
states change frequently and must NOT trigger buffer rebuilds. Classify every input:

### Static vertex buffers (uploaded on graph build; see invalidation list)

- Node model positions `_3dLobe`, per-node `nodeRadius`, hub flag, status, per-node
  `lobeIndex` (0–5) and `nodeColor` (from `node.color`).
- Edge ribbon vertices: the 13 model-space Bézier sample points per edge (control point
  `(A+B) × 0.35`), expanded to a triangle strip; per-vertex carry: endpoint lobe colors
  `cA`/`cB`, a **`flat` per-segment** color selector and a **`flat` per-segment** depth-fade
  value (see Fidelity Strategy), `sameLobe` flag, the two endpoint `lobeIndex`es, the two
  endpoint node-indices (for focus/hover lookup), and `edge.A.color` (focus override color).
- Cloud: model positions, per-point `lobeIndex`, twinkle `phase` and `freq`, far/near flag
  derived per frame from projected `z` (so cloud far/near radius+alpha is chosen in-shader from
  the sign of projected z, not baked).

### Per-frame uniforms (no buffer change)

- Projection inputs (rot, zoom, width, height, dpr → matrix + `dist = 3.4`, `scale = min(w,h)
  × 0.32 × zoom`, `cx = w/2`, `cy = h/2 − h×0.04`) and `time`.
- `uLobeMul[6]` — `lobeVisibilityMultiplier` per lobe (disabled = 0.08; with a highlight,
  highlighted = 1, others = 0.16; no highlight = 1). Recomputed when `enabledLobes` or
  `highlightLobe` change. Edges/signals use `max(uLobeMul[lobeA], uLobeMul[lobeB])`.
- `uFocusNodeIndex`, `uHoverNodeIndex` (or −1). The vertex/fragment shaders reproduce, from
  these uniforms: edge focus/hover alpha selection + the focus single-color override
  (`edge.A.color`), and node hover/focus **radius** bumps (1.18 / 1.25).
- `uHighlightLobe` for the haze base-alpha split (0.18 highlighted vs 0.07).

These changing per frame (hover on nearly every mouse move; highlight on legend hover) is why
they must be uniforms, never rebuilds.

### Node drag (per pointermove) — partial update, not full rebuild

`onPointerMove` mutates the dragged node's `_3dLobe` every move. Do **not** re-upload the whole
edge buffer per move. Build a node-index → incident-edge-vertex-range map at buffer-build time;
on drag, `gl.bufferSubData` only the dragged node's position and the vertex ranges of its
incident edges. (Alternative: keep the dragged node's ribbons in a small dynamic buffer and pass
a drag-delta uniform, rebaking into the static buffer on pointerup.) The plan must implement one
of these; a naive full rebuild reintroduces the CPU/GC cost the rewrite exists to remove.

### Signals — small per-frame dynamic buffer

Signals are inherently per-frame: each active signal recomputes 6 trailing Bézier points with
time-varying `t`, envelope, color lerp, and radius. Maintain a small dynamic buffer rebuilt each
frame from the (typically single-digit) active signal list. Cost is negligible; just state it.

### Buffer invalidation triggers (enumerate)

Geometry buffers rebuild on: **graph rebuild**, **node `_lobeName` reassignment**. Position
buffers update (partial) on **node drag**. **Color** attributes rebuild on **palette change**
(`setOptions({palette})` / `rebuild` — lobe colors come from `graph.activePalette.kinds` via
`LOBE_KIND`, node colors from `node.color`); the `daylight` palette is in the success criteria,
so this must be wired. Distinguish geometry-invalidating from color-invalidating rebuilds so a
palette switch does not re-tessellate ribbons.

## Fidelity Strategy

- **Premultiplied-alpha output (mandatory).** Every fragment outputs **premultiplied** color:
  `outRGB = a × straightRGB`, `outA = a`, where `a` is the per-fragment alpha (including radial
  falloff). With this: additive "lighter" = `blendFunc(ONE, ONE)`; source-over =
  `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`. Without premultiplication the additive passes render
  ~5× too bright. Radial-gradient stops are interpolated in **straight** space (matching
  Canvas2D `createRadialGradient`), premultiplied once at the end.
- **Context attributes:** `{ alpha: false, antialias: false, premultipliedAlpha: true }`.
  `alpha:false` makes the WebGL canvas opaque (the scene always begins with the opaque
  background quad), so canvas-to-page compositing is a no-op and exactly mirrors today's opaque
  Canvas2D backbuffer. `antialias:false` because all AA is analytic in-shader (MSAA on
  transparent-cornered quads would be useless and mildly harmful).
- **Analytic coverage AA:** point sprites (nodes, cloud, white core dot) compute coverage as a
  ~1 **device**-pixel-wide analytic edge from distance-to-center, sized in device pixels (×dpr),
  to match Canvas2D `arc()+fill` on sub-2px circles. Edges/hub-ring/crosshair render as ribbons
  whose fragment shader computes distance-to-centerline coverage (`clamp(halfWidth − dist +
  0.5, 0, 1)`) to reproduce sub-pixel `lineWidth` (0.55 / 0.7 / 1.3) partial coverage. Build
  ribbons wider than the line by a 1px AA margin.
- **Stair-step exactness (no smoothing):** the per-segment constant alpha
  (`baseA × (1 − midpointDepth × 0.35)`) and the inter-lobe color hard-switch (`t < 0.5 ? cA :
  cB`, switching at the geometric midpoint) are reproduced with **`flat`-qualified per-segment
  attributes** using WebGL2's last-vertex provoking convention — NOT interpolated `t` thresholds
  (which would shift the switch half a segment and smooth the alpha). This keeps the output
  byte-faithful, not "improved."
- **Gamma / framebuffer:** default (non-sRGB) framebuffer so blending happens in gamma-encoded
  space exactly like Canvas2D. Do not enable any sRGB framebuffer/conversion.
- **Color conversion:** palette hex → normalized float RGB `[0,1]` (component / 255). Signal
  color lerp currently rounds in 0–255 space (`lerpHex`); reproduce with the same quantization
  in-shader if strict identity is needed (otherwise note as a sub-1/255 deviation).
- **Derived per-point `scale` and `depth`:** computed in-shader from camera-space `z2` with the
  identical formulas. In `makeProjector`, `f = sceneScale/(dist+z2)` and the returned per-point
  `scale = f × dist / sceneScale = dist / (dist + z2)` (the scene scale cancels — do not leave a
  `dist/sceneScale` factor in); `depth = (z2 + 1.5)/3`. Apply the same clamps where they occur:
  `max(0.55, scale)` for node radius, `max(0.6, scale)`/`max(0.5, scale)` for labels/signals,
  `max(0.32, 1 − depth×0.75)` node fade, etc.
- **Draw order (identical, back-to-front), toggling blend per pass:**
  1. Background gradient (full-screen quad; radial, center `(cx,cy)`, radius `max(w,h) × 0.75`,
     stops `bg @0 / bg @0.55 / bgFar @1`).
  2. Lobe haze (additive), sorted by projected `z` desc.
  3. Cloud points with `z > 0` (additive).
  4. Edges `z > 0` (source-over), sorted; then nodes `z > 0`, sorted.
  5. Cloud points with `z <= 0` (additive).
  6. Edges `z <= 0` (source-over), sorted; then nodes `z <= 0`, sorted.
  7. Signals (additive).
  8. (overlay canvas) lobe labels, node labels, compass — source-over.
  Edges are bucketed/sorted by **edge mean z** (matches today; no per-segment z-sort, no depth
  buffer). Sorts must be **stable** with the same tiebreak (original `graph.edges`/`graph.nodes`
  order). Sorting runs on the CPU over indices/keys — far cheaper than projecting + stroking.

## Numeric Fidelity Appendix (the contract)

`src/renderer.ts` is the canonical reference; reproduce these exactly. Key constants for the
WebGL geometry passes (line refs are to current `renderer.ts`):

- **Projection (`draw`):** `scale = min(w,h) × 0.32 × zoom`; `cx = w/2`; `cy = h/2 − h×0.04`;
  `dist = 3.4`. `makeProjector` math per `shape.ts`. `scale`/`depth` derived as above.
- **Background:** radial center `(cx,cy)`, radius `max(w,h) × 0.75`, stops `bg/bg/bgFar` at
  `0/0.55/1`.
- **Lobe haze:** radius `lobeCenter.r × sceneScale × 1.4 × pr.scale`; `depthFade = max(0.25,
  1 − pr.depth × 0.55)`; `baseA = (highlight===lobe ? 0.18 : 0.07) × depthFade × lobeMul`; skip
  if `baseA < 0.005`; gradient `baseA @0 / baseA×0.45 @0.55 / 0 @1`; additive; includes mirror
  centers; color via `lobeColor(lobe)`.
- **Cloud:** `alphaBase = far ? 0.20 : 0.38` (far = projected `z > 0`); `alpha = (1 − pr.depth)
  × alphaBase × tw × lobeMul`; `tw = 0.65 + 0.35 × sin(time × 0.0005 × freq + phase)`; radius
  `far ? 0.95 : 1.2`; additive; color via `lobeColor`.
- **Edges:** `cA/cB = lobeColor(A/B lobe)`; `lobeM = max(lobeMul(A), lobeMul(B))`; `interBoost =
  sameLobe ? 1 : 1.6`; `baseA = (isFocus ? (isFar?0.55:0.85) : isHover ? (isFar?0.25:0.40) :
  (isFar?0.05:0.13)) × lobeM × interBoost`; `lineWidth = isFocus ? 1.3 : (isFar ? 0.55 : 0.7)`;
  per-segment `alpha = baseA × (1 − avgSegmentDepth × 0.35)`; color `sameLobe ? cA : (t<0.5 ? cA
  : cB)`; **focus edges use a single color `edge.A.color` across the whole edge.** `isFar` =
  edge mean `z > 0`.
- **Nodes:** `nodeRadius = hub ? 6.5 : 2.6 + min(3.4, degree × 0.42)`; `radius = nodeRadius ×
  max(0.55, pr.scale) × (isHover ? 1.18 : isFocus ? 1.25 : 1)`; `fade = max(0.32, 1 − pr.depth ×
  0.75)`; `dim = archived ? 0.30 : dormantRelevant ? 0.55 : 1`; `alpha = fade × dim × lobeMul`;
  skip if `alpha < 0.05`. Halo: radius `radius × 3.6 × CHAOS.halo`, stops `0.32 × alpha ×
  CHAOS.bloom @0 / 0 @1`, color `node.color`. Core: `node.color @ min(1, alpha × 0.93)`. White
  inner dot: `rgba(255,255,255, min(1, alpha))`, radius `max(0.7, radius × 0.42)`. Hub ring:
  `node.color @ min(1, 0.55×alpha)`, lineWidth 0.8, radius `radius + 4`; hub crosshair:
  `node.color @ min(1, 0.45×alpha)`, lines ± `radius × 3.2` horizontal & vertical.
- **Signals:** spawn every 900 ms on a random inter-lobe edge, random direction, `dur = 2400 +
  rand×1100`, `colA/colB = node.color`. Per signal: `tNorm = (now−born)/dur` (skip outside
  0..1); `envelope = sin(tNorm × π)`; `regionAlpha = max(lobeMul(a), lobeMul(b))`; control
  `(a+b)×0.35`. 6 trailing sub-sprites `i = 0..5`: `t = max(0, tNorm − i×0.035)`; color
  `lerpHex(colA, colB, t)`; `fade = (1 − i/6) × envelope`; `depth = max(0.3, 1 − pr.depth ×
  0.6)`; `radius = (1.3 − i×0.15) × max(0.5, pr.scale)`; halo radius `radius × 3.2`, alpha
  `0.22 × fade × depth × regionAlpha`; core alpha `0.55 × fade × depth × regionAlpha`, radius
  `max(0.6, radius)`. Additive.
- **`lobeColor`:** `palette.kinds[LOBE_KIND[lobe]] ?? palette.hud`, with `LOBE_KIND` = frontal→
  project, parietal→concept, temporal→person, occipital→source, cerebellum→dailyNote, stem→
  index.
- **`lobeVisibilityMultiplier`:** disabled 0.08; highlighted (or no highlight) 1; other when a
  highlight is set 0.16.
- **Hit-test:** `projCache` of node screen positions each frame; ignore `z > 0.4`; tolerance
  `max(7, 18 / sqrt(zoom))`.
- **Idle auto-rotate:** `rot.y += 0.00065` after 1800 ms idle, not dragging.

Overlay (labels/lobe-labels/compass) is reused verbatim from `renderer.ts`; its constants
(fonts, backplate `rgba(0,0,0,0.5α)`, `z>0.25` non-hub cull, lobe-label lead-line offsets,
compass own projector `scale = radius×4.5, dist = 4, center (w−50,h−50), radius 22`, front-fade)
are preserved by literal reuse and must not be re-derived. The compass overlay must receive live
`rot` each frame and reconstruct its **own** projector (`dist = 4`, not the scene's 3.4).

## Carried Over Unchanged

- `performancePreset` / `mobile` frame pacing, `maxDevicePixelRatio` DPR cap, label-density caps
  — moved into `render-core`, behavior identical, used by both renderers.
- Settings schema/tab, adapter, classify, palette, shape math, node-display.
- The in-flight Mobile preset work (committed first; see Sequencing) tunes the Canvas2D path.

## WebGL2 Unavailable, Mobile, and Context Loss

- **Selection:** a `rendererMode` setting (`auto` | `webgl2` | `canvas2d`, default `auto`)
  gates the choice. In `auto`: mobile runtime → Canvas2D; desktop with WebGL2 → WebGL2; desktop
  without WebGL2 → Canvas2D. `webgl2`/`canvas2d` force the path (still falling back to Canvas2D
  if a forced WebGL2 context can't be created). This is both a user escape hatch (force Canvas2D
  if WebGL misbehaves) and the mechanism for A/B testing the two renderers in real Obsidian. It
  adds one dropdown to the settings tab and one field to the settings schema + normalization.
- **No throw:** failure to obtain a context routes to the Canvas2D renderer (or, if that also
  fails, the existing empty-state overlay DOM — `brain-atlas-empty` / `is-visible`), never an
  uncaught error through `onOpen`.
- **Context loss:** handle `webglcontextlost` (preventDefault, pause) / `webglcontextrestored`
  (recreate programs, re-upload buffers). Backgrounding is the normal trigger; integrate with
  the view's existing `onShow`/`onHide`/`onClose` → `start`/`stop` lifecycle. If restore fails,
  fall back to Canvas2D.

## Sequencing

1. **Commit the in-flight Mobile-preset work first** (already complete and tested; currently
   uncommitted in `renderer.ts`, `settings.ts`, `settings-tab.ts`, `view.ts`, `README.md`,
   tests). Locks the mobile contract and the fallback target.
2. **Extract `render-core.ts`** from `renderer.ts` (interaction, scheduling, hit-test, signals,
   options) + add the determinism seams; keep Canvas2D behavior identical; tests green.
3. **Stand up the A/B pixel-diff harness early** against the Canvas2D reference alone (it should
   diff the reference against itself at ~0 difference), plus the `install-local` script. This
   gives a working fidelity gate *before* the WebGL renderer exists, so WebGL is built against a
   live target.
4. **Implement the WebGL2 renderer** + `rendererMode` setting + two-canvas wiring + renderer
   selection in `view.ts`, iterating until the A/B gate passes across the matrix.
5. **Verify** in real Obsidian (toggle `rendererMode`) and via the manual checklist; ship.

## Testing

jsdom has no WebGL or real canvas. Strategy:

- **Pure-function unit tests** (no GL context): `projection.ts` — for sample model points the
  full tuple `{sx, sy, z, scale, depth}` and all clamps match `makeProjector`/`draw` (with
  `dist = 3.4`, scene `scale`, `cy` offset) within epsilon; `buffers.ts` — ribbon vertex counts,
  `flat` per-segment color/depth attributes, same-lobe vs inter-lobe, focus-override color
  carried, cloud counts + twinkle attrs, node-index→incident-edge-range map; hex→float color
  conversion matches `hexA` numerics; draw-order/pass list given sample z values matches the
  current ordering and stable tiebreak; capability-detection branch (mobile/no-WebGL2 →
  Canvas2D) is pure and tested.
- **Keep/repoint source-grep tests.** Existing tests grep `src/renderer.ts` for exact strings.
  Because frame-pacing / label-gating / interaction move to `render-core.ts`, the plan must list
  each affected test → new target (repoint the grep to the new module, or keep the asserted
  string physically in `renderer.ts`):
  - `renderer-interaction.test.mjs`: `PERFORMANCE_FRAME_DELAYS`, `balanced/batterySaver/mobile`
    delays, `effectivePerformancePreset`, `maxDevicePixelRatio`, `scheduleNextFrame(0)`,
    `MAX_ZOOM = 6`, `hitTolerance`.
  - `renderer-labels.test.mjs`: the literal `if (this.options.showLobeLabels) this.drawLobeLabels`.
  - `view-ux.test.mjs`: `event.stopPropagation()`, `mode: "node"`, `consumeSuppressedClick`,
    `onPinNode`. Note `displayNodeName` is exercised in label drawing, which stays on the
    Canvas2D overlay reused verbatim, so that grep needs **no** repoint.

  New `src/gl/*.ts` pure modules import fine under Node type-stripping; keep all
  `WebGL2RenderingContext` usage behind functions, never module-level instantiation.
- **Automated A/B pixel-diff gate (CI).** Pure-function tests verify math, not pixels — so add a
  Playwright harness (dev-only `devDependency`, never shipped in `main.js`, policy-compliant) that
  runs in headless Chromium (WebGL2 available via SwiftShader). For a fixed synthetic graph and a
  matrix of conditions, it renders **one deterministic frame** through both paths and compares
  them **A/B on the same machine** (not against stored golden images, which drift across GPUs):
  - Render the Canvas2D reference into its canvas; render the WebGL path (geometry canvas +
    overlay canvas) and composite the overlay onto a readback of the geometry canvas.
  - Diff the two composited images with `pixelmatch` at a tuned tolerance + max-different-pixels
    budget. Tolerance is set to ignore last-mile AA (sub-pixel coverage on tiny circles/thin
    lines) while still catching the bugs that matter: wrong brightness (e.g. the premultiply
    bug), a missing/extra pass, wrong palette/lobe color, wrong geometry/curve, dropped status
    dimming.
  - Matrix: each palette (incl. `daylight`), a few camera angles, focus + hover states, lobe
    highlight, and a hub-heavy graph. Each case asserts diff ratio < threshold.
  - Wire into `.github/workflows/ci.yml` as a gate (cache the Playwright browser). This protects
    `main` (branch protection requires CI) and runs before any release tag.
- **Local Obsidian verification.** Add an `npm run install-local` script (build → copy
  `manifest.json`, `main.js`, `styles.css` into a configured `<vault>/.obsidian/plugins/brain-atlas/`
  per the workspace install convention; vault path via env var, not committed). The
  `rendererMode` setting (Auto/WebGL2/Canvas2D) lets you toggle paths inside real Obsidian on your
  own GPU and eyeball them against each other. Document the loop (toggle, disable/enable plugin or
  reload to pick up a new `main.js`) in the PR.
- **Manual checklist** (belt-and-suspenders, in the PR): the matrix above plus node drag (incl.
  hub), idle auto-rotate, zoom extremes, and a device/webview where `getContext("webgl2")`
  returns null — confirming no visible difference and clean fallback. The automated gate covers
  the static-frame cases; the manual pass covers motion and interaction.

## Risks

- **Pixel-exact gradients, premultiplied blending, and analytic AA** are the main fidelity risk.
  Mitigation: explicit premultiply convention, straight-space stop interpolation, analytic
  coverage sized in device px, `flat` per-segment attributes, side-by-side vs the retained
  reference.
- **Drag/dynamic-state perf** (avoiding full rebuilds). Mitigation: incident-edge `bufferSubData`
  / delta uniform; uniforms for hover/focus/highlight; small dynamic signal buffer.
- **Context loss / driver variance / mobile webviews.** Mitigation: Canvas2D fallback, context-
  loss handling, mobile defaults to Canvas2D.
- **Larger surface to review.** Mitigation: small focused files, inline shaders, pure-function
  tests, retained reference renderer for diffing.

## Success Criteria

- Desktop CPU usage while idle-rotating at default caps drops substantially (GPU does projection
  + rasterization; CPU updates uniforms and issues draws).
- No per-frame color-string allocation in the WebGL geometry pipeline.
- Output is visually indistinguishable from the Canvas2D reference: the CI A/B pixel-diff gate
  passes across the palette/angle/state matrix (within the tuned tolerance), and the manual +
  real-Obsidian checks show no visible difference, including the quantized stair-step alpha and
  mid-edge color switch.
- The A/B harness, `install-local` script, and `rendererMode` setting exist and the gate runs in
  CI (protecting `main`).
- Mobile and no-WebGL2 devices keep working via the Canvas2D fallback; clean recovery from
  context loss; no thrown errors.
- `npm test` and `npm run build` pass; bundle gains only hand-rolled WebGL code (no deps).
- `versions.json` gets a new entry for the release (maps to `minAppVersion 1.5.0`, unchanged —
  `minAppVersion` does not gate GPU/webview WebGL2 support; the fallback does).
