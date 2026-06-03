# Brain Atlas WebGL2 Renderer — Design

**Date:** 2026-06-03
**Issue:** [#2 — Stunning 3D view! (But it's cooking my CPU)](https://github.com/colorpulse6/brain-atlas/issues/2)
**Status:** Approved design, pending implementation plan

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

Eliminate the per-frame CPU projection, the 48k per-segment strokes, and the per-frame
color-string allocations by moving the geometry pipeline to the GPU via WebGL2 — **without any
visible change to the rendered output.** Visual identity is a hard requirement: the new
renderer must reproduce the current look. WebGL is the no-compromise path because per-vertex
color/alpha interpolation reproduces the exact along-edge gradient and depth fade natively,
something the cheap Canvas2D shortcuts (merged strokes, quantized alpha) cannot.

## Non-Goals

- No three.js or any rendering dependency. Hand-rolled WebGL2 keeps the bundle small and the
  source reviewable per Obsidian policy (no obfuscation, no blobs).
- No WebGPU. It is not reliably available in Obsidian's Electron runtime yet.
- No change to privacy/network posture. WebGL runs entirely on the user's own GPU. No server,
  no account, no dependency. "Local-only rendering" stays true verbatim.
- No changes to `adapter.ts`, `classify.ts`, `palette.ts`, `shape.ts` math, or settings schema
  beyond what already exists.

## Architecture — Approach A (Hybrid: WebGL2 geometry + Canvas2D text overlay)

Two stacked, same-sized canvases inside the view container:

1. **WebGL2 canvas (bottom)** renders everything that blends against the background:
   background gradient, lobe haze, point cloud, edges, node halos + cores, signals.
2. **Canvas2D overlay (top, transparent)** renders only what is drawn dead-last today with
   plain source-over compositing: node labels + black backplates, lobe labels/dots/lead-lines,
   and the compass.

### Why the split is fidelity-preserving (critical)

The current renderer uses `globalCompositeOperation = "lighter"` (additive) for the cloud and
signals. Additive blending adds the source color onto whatever is already in the canvas —
**including the background and haze.** Moving any additive element to a separate transparent
canvas would make it add onto transparent and then composite over the background — a different,
wrong result.

Therefore **everything additive-or-over-background must share one canvas** → all of it goes to
WebGL, background and haze included. Only elements drawn dead-last with plain source-over may
live on an overlay, because compositing a transparent overlay onto the result with source-over
is mathematically identical to drawing those elements last in a single canvas. The current draw
order already draws labels and the compass last, so the overlay split is provably faithful.

### Rejected approaches

- **B. Full WebGL including text via a glyph atlas.** More code, real risk of text differing
  from native `fillText`, and no meaningful gain (labels are cheap — a few dozen per frame).
- **C. `gl.POINTS` / `gl.LINES` primitives.** Point/line anti-aliasing and line width are
  driver-dependent and will not match Canvas2D's smooth circles/strokes. Fails the
  pixel-identical bar. This is why Approach A uses textured quads / triangle-strip ribbons
  instead, putting anti-aliasing under our own fragment-shader control.

## Components / Files

- **`src/gl/brain-gl-renderer.ts`** — the WebGL2 renderer. Exposes the **same public surface**
  as today's `BrainRenderer` (`start`, `stop`, `setOptions`, `setHighlightLobe`,
  `getHoveredNode`, `getFocusedNode`, `getLobeStats`, `hitTest`, `consumeSuppressedClick`) so
  `view.ts` changes only in how it constructs the renderer and that it now owns two canvases.
- **`src/gl/shaders.ts`** — vertex and fragment shader source strings (inline, reviewable).
- **`src/gl/programs.ts`** — minimal compile/link/uniform/attribute helpers (~80 lines, no deps).
- **`src/gl/buffers.ts`** — builds and uploads the model-space vertex buffers (nodes, edge
  ribbons, cloud). Pure data transforms, unit-testable without a GL context.
- **Canvas2D overlay drawing** — reuse the existing `drawNodeLabels`, `drawLobeLabels`,
  `drawLobeLabel`, `drawLobeDot`, `drawCompass`, and `automaticLabelIds`/`maxAutomaticLabels`
  logic essentially verbatim, operating on the overlay context.

The existing `src/renderer.ts` is replaced as the active renderer. Pointer interaction,
drag/rotate/zoom math, hit-testing, signal spawning, and frame scheduling move into (or are
shared by) the new renderer unchanged in behavior.

## Data Flow — where the win comes from

Node 3D positions and the 13-point Bézier samples per edge are **static in model space**; they
change only when a node is dragged/pinned or the graph rebuilds. Rotation changes every frame,
but rotation is just a uniform matrix.

- **On graph change / node drag (infrequent):** rebuild and upload vertex buffers once —
  node positions; edge ribbon vertices carrying per-vertex color and an alpha/depth-fade factor
  and an inter-lobe color-mix parameter; cloud points with per-point color, twinkle phase, and
  twinkle frequency.
- **Every frame (cheap):** update uniforms (projection/rotation matrix derived from
  `rot`, `zoom`, `width`, `height`, `dpr`; current `time`; lobe-visibility multipliers;
  highlight lobe), then issue the draw passes. The ~52k projections happen on the GPU in
  parallel. **Zero CPU projection for geometry, zero per-frame color-string allocation.**

Hit-testing still computes node screen positions on the CPU (only the ~1500 nodes, cheap) so
hover/click/drag keep working exactly as today. This CPU node projection reuses the same
`makeProjector` math in `shape.ts`.

## Fidelity Strategy

- **Smooth circles & edges:** nodes and cloud points render as point-sprite quads with a radial
  alpha falloff computed in the fragment shader; edges render as triangle-strip ribbons. AA is
  controlled in-shader to match Canvas2D's smooth output rather than relying on driver AA.
- **Along-edge depth fade & inter-lobe midpoint color switch:** encoded as per-vertex
  attributes and interpolated by the GPU, reproducing the current per-segment values. The
  inter-lobe edges currently hard-switch color at the midpoint (`t < 0.5 ? cA : cB`) — that is
  modeled by passing both endpoint colors plus a per-vertex `t` and selecting in the shader.
- **Focused-edge color override:** when an edge touches the focused node, the current
  `drawEdge` ignores the lobe-color gradient and strokes the **entire** edge in a single color
  (`edge.A.color`, the source node's own `color`) at the focus alpha. The buffer/shader path
  must be able to express a uniform single color for an edge, not only the two-endpoint
  gradient, so focus rendering stays faithful.
- **Radial gradients (background, haze, halos, signals):** reproduced with distance-based
  color-stop math in fragment shaders, matching exact stop positions and alphas. Background:
  stops at position 0 (`bg`), 0.55 (`bg`), 1.0 (`bgFar`). Node halo: position 0 at alpha
  `0.32 × alpha × graph.CHAOS.bloom`, position 1 at alpha 0. Lobe haze: position 0 at `baseA`,
  position 0.55 at `baseA × 0.45`, position 1.0 at 0.
- **Node body specifics:** preserve the `graph.CHAOS.halo` halo-radius multiplier and
  `graph.CHAOS.bloom` halo-alpha multiplier, the core fill at alpha `min(1, alpha × 0.93)`, the
  white inner-core dot at `rgba(255,255,255,alpha)` with radius `max(0.7, radius × 0.42)`, and
  the hub ring + crosshair strokes. None of these factors may be dropped.
- **Blend math:** premultiplied alpha. `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)` for source-over,
  `blendFunc(ONE, ONE)` for "lighter" (additive). Use the **default, non-sRGB framebuffer** so
  blending happens in gamma-encoded space exactly as Canvas2D does — do not enable an sRGB
  framebuffer.
- **Color conversion:** palette hex → normalized float RGB `[0,1]` (component / 255), so shader
  colors match the values Canvas2D would have produced.
- **Draw order:** issue passes in the **identical back-to-front order** the current `draw()`
  uses, toggling blend mode per pass:
  1. Background gradient (full-screen quad)
  2. Lobe haze (additive), sorted by depth
  3. Cloud points with `z > 0` (additive)
  4. Edges `z > 0` (source-over), sorted; then nodes `z > 0`, sorted
  5. Cloud points with `z <= 0` (additive)
  6. Edges `z <= 0` (source-over), sorted; then nodes `z <= 0`, sorted
  7. Signals (additive)
  8. (overlay canvas) lobe labels, node labels, compass — source-over
  Depth sorting still runs on the CPU per frame but operates on indices/keys, far cheaper than
  projecting + stroking. Where draw-order ties are currently broken by array order, preserve
  the same tiebreak.

## Carried Over Unchanged

- `performancePreset` / `mobile` frame pacing (`PERFORMANCE_FRAME_DELAYS`,
  `nextFrameDelay`, `effectivePerformancePreset`) — frame scheduling is renderer-agnostic.
- `maxDevicePixelRatio()` DPR cap (mobile = 1, otherwise 2) — applied when sizing both canvases.
- Mobile label-density caps in `maxAutomaticLabels` / focus-neighbor label limits — these live
  in the overlay path.
- Settings schema, settings tab, adapter, classify, palette, shape math, node-display.

## WebGL2 Unavailable — Graceful Degradation

If `canvas.getContext("webgl2")` returns null (old GPU, blocklisted driver, headless), the view
renders a clear centered message (e.g. "Brain Atlas requires WebGL2, which isn't available in
this environment.") instead of a black canvas. We deliberately do **not** maintain a parallel
Canvas2D renderer as a fallback — that would defeat the purpose and double the maintenance
surface. Handle WebGL **context loss** (`webglcontextlost`/`webglcontextrestored` events) by
pausing and re-uploading buffers on restore.

## Sequencing

1. **Commit the existing in-flight `mobile`-preset work first** (already complete and tested,
   currently uncommitted in `renderer.ts`, `settings.ts`, `settings-tab.ts`, `view.ts`,
   `README.md`, and tests). This locks the mobile contract before the refactor reshuffles
   `renderer.ts`.
2. **Then implement the WebGL2 renderer**, carrying the mobile/preset semantics into it.

## Testing

The existing tests are source-grep assertions because jsdom has no WebGL or canvas. Strategy:

- **Keep** source-grep/wiring assertions for the overlay, settings, and view wiring.
- **Add unit tests** for the pure, GL-independent pieces (no GL context needed):
  - projection/rotation matrix construction (compare against `makeProjector` output for sample
    points — the GPU matrix must agree with the CPU projector used for hit-testing).
  - edge-ribbon vertex generation (counts, per-vertex color/`t`/depth-fade attributes,
    inter-lobe vs same-lobe handling).
  - cloud buffer generation (point count, color, twinkle phase/freq attributes).
  - hex → normalized-float color conversion (matches `hexA` numerics).
  - draw-order/pass list given a set of projected z values (matches the current ordering and
    tiebreaks).
- **Manual verification checklist** in the PR: side-by-side against the Canvas2D build across
  palettes (incl. `daylight`), with/without focus + hover, hub nodes, signals, lobe toggles,
  zoom extremes, and the mobile preset, confirming no visible difference.

## Risks

- **Pixel-exact gradients & blending** are the main fidelity risk. Mitigation: reproduce exact
  stop positions and gamma-space blending; verify side-by-side; iterate on shader math.
- **Context loss / driver variance.** Mitigation: handle context-loss events; graceful notice
  when WebGL2 is absent.
- **Larger renderer surface to review.** Mitigation: small focused files (`shaders`, `programs`,
  `buffers`, renderer), inline shader source, unit tests on the pure pieces.

## Success Criteria

- CPU usage while idle-rotating at default caps drops substantially (the GPU does projection and
  rasterization; the CPU updates uniforms and issues draw calls).
- No per-frame color-string allocation in the geometry pipeline.
- Output is visually indistinguishable from the current Canvas2D renderer across the manual
  verification checklist.
- `npm test` and `npm run build` pass; bundle gains only the hand-rolled WebGL code (no deps).
- Graceful message when WebGL2 is unavailable; clean recovery from context loss.
