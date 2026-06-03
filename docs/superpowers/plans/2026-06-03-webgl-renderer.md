# Brain Atlas WebGL2 Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the desktop geometry pipeline to a hand-rolled WebGL2 renderer to eliminate per-frame CPU projection, 48k per-segment strokes, and per-frame RGBA string allocation (issue #2) — with no visible change to the rendered output, verified by an automated A/B pixel-diff gate.

**Architecture:** Dual renderer behind a shared `render-core` base. Desktop with WebGL2 → new `BrainGLRenderer` (WebGL2 geometry canvas + Canvas2D text overlay). Mobile / no-WebGL2 / context-loss → the existing `BrainRenderer` (Canvas2D), retained as the canonical fidelity reference and tuned by the Mobile preset. A Playwright A/B pixel-diff harness renders the same deterministic frame through both paths and diffs them on the same machine.

**Tech Stack:** TypeScript, WebGL2 (no three.js, no runtime deps), esbuild bundle, `node --test` for unit/source tests, Playwright + pixelmatch + pngjs (devDependencies) for the A/B gate, GitHub Actions CI.

**Spec:** `docs/superpowers/specs/2026-06-03-webgl-renderer-design.md` — the **Numeric Fidelity Appendix** in the spec is the constants contract; this plan references it rather than duplicating every value. `src/renderer.ts` is the canonical reference renderer.

**Conventions in this repo:**
- Tests are `test/*.test.mjs`, run with `npm test` (`node --no-warnings --test test/*.test.mjs`).
- Pure-function tests import `.ts` directly (e.g. `import { x } from "../src/foo.ts"`) — Node 22 strips types.
- Source-assertion tests read a file with `readFileSync(new URL("../src/foo.ts", import.meta.url))` and `assert.match`.
- Build: `npm run build` (`tsc -noEmit -skipLibCheck && esbuild … production`).
- Keep all `WebGL2RenderingContext` usage **inside functions**, never at module top level, so `src/gl/*.ts` imports don't throw under Node.

---

## File Structure

**Create:**
- `src/render-core.ts` — shared base: interaction, frame scheduling, hit-test, signal spawn, options, lobe stats, determinism seams. Both renderers extend it.
- `src/gl/projection.ts` — pure projection: `{sx,sy,z,scale,depth}` math + clamps, numerically locked to `makeProjector`.
- `src/gl/color.ts` — pure hex→float-RGB and premultiply helpers.
- `src/gl/buffers.ts` — pure vertex-array builders (ribbon, cloud, node) + node→incident-edge range map.
- `src/gl/programs.ts` — minimal compile/link/uniform/attribute helpers (GL calls behind functions).
- `src/gl/shaders.ts` — inline GLSL source strings.
- `src/gl/brain-gl-renderer.ts` — the WebGL2 renderer.
- `test/projection.test.mjs`, `test/gl-color.test.mjs`, `test/gl-buffers.test.mjs`, `test/render-core.test.mjs`, `test/renderer-mode.test.mjs` — unit tests.
- `test/ab/harness.html`, `test/ab/harness.mjs`, `test/ab/ab-fidelity.test.mjs` (or `.spec.ts`) — Playwright A/B pixel-diff harness + fixture graph.
- `scripts/install-local.mjs` — build + copy artifacts into a vault.

**Modify:**
- `src/renderer.ts` — extend `render-core`, implement `drawScene()`; keep Canvas2D output identical.
- `src/view.ts` — pass container (not a canvas); renderer selection; interaction-target wiring.
- `src/settings.ts`, `src/settings-tab.ts` — add `rendererMode`.
- `test/renderer-interaction.test.mjs`, `test/renderer-labels.test.mjs`, `test/view-ux.test.mjs` — repoint moved source-grep assertions.
- `.github/workflows/ci.yml` — add the Playwright A/B job.
- `package.json` — devDeps (playwright, pixelmatch, pngjs), `install-local` + `test:ab` scripts.
- `README.md`, `versions.json` — release-time updates.

---

## Task 1: Commit the in-flight Mobile-preset work

The working tree already contains complete, tested Mobile-preset work (`renderer.ts`, `settings.ts`, `settings-tab.ts`, `view.ts`, `README.md`, tests). Lock it in before refactoring `renderer.ts`. (Optionally cherry-pick to its own PR to `main` first; it is independent of WebGL.)

- [ ] **Step 1: Verify the existing work passes tests**

Run: `npm test`
Expected: PASS (all suites green, including the mobile-preset assertions already added).

- [ ] **Step 2: Verify it builds**

Run: `npm run build`
Expected: tsc clean, esbuild writes `main.js`.

- [ ] **Step 3: Commit the mobile work**

```bash
git add src/renderer.ts src/settings.ts src/settings-tab.ts src/view.ts README.md test/
git commit -m "feat: add Mobile performance preset and mobile-runtime detection"
```

---

## Task 2: Extract `render-core.ts` (shared base + determinism seams)

Move everything that is not "how pixels are drawn" out of `renderer.ts` into a base class both renderers extend. Behavior must stay identical — this is a refactor guarded by the existing tests staying green, plus new tests for the determinism seams.

**Files:**
- Create: `src/render-core.ts`
- Modify: `src/renderer.ts`
- Test: `test/render-core.test.mjs`, and repoint `test/renderer-interaction.test.mjs`

- [ ] **Step 1: Create `src/render-core.ts` with the base class**

Move from `renderer.ts` into an abstract `RenderCore` class: the fields `rot`, `zoom`, `drag`, `lastUserAt`, `suppressClickUntil`, `projCache`, `signals`, `lastSpawn`, `hoverId`, `focusId`, `highlightLobe`, `width`, `height`, `dpr`, `options`; the methods `start`/`stop` (canvas/listener lifecycle), `setOptions`, `setHighlightLobe`, `getHoveredNode`, `getFocusedNode`, `getLobeStats`, `hitTest`, `hitTestProjected`, `consumeSuppressedClick`, `hitTolerance`, all pointer handlers (`onPointerDown/Move/Up/Leave`, `onWheel`, `onContextMenu`), `localPoint`, `draggedNodePosition`, `moveNodeTo`, `cameraRight/Up`, `currentProjectionScale`, `scheduleNextFrame`, `requestImmediateFrame`, `nextFrameDelay`, `effectivePerformancePreset`, `resize`, `maxDevicePixelRatio`, `ensureLobePositions`, `emptyLobeStats`, `lobeColor`, `spawnSignals`, and `PERFORMANCE_FRAME_DELAYS`/`MIN_ZOOM`/`MAX_ZOOM` constants. Add one abstract method:

```ts
protected abstract drawScene(now: number): void;
```

The base's `draw = (now) => { … shared setup …; this.drawScene(now); this.scheduleNextFrame(this.nextFrameDelay(now)); }` — but keep the per-frame setup (`ensureLobePositions`, idle auto-rotate, building `projCache` from CPU node projections used by hit-test) in the base so hit-testing works for both renderers. Decide the split: base computes the CPU node `projCache` each frame (needed for hit-test in both); `drawScene` does the visual drawing.

- [ ] **Step 2: Add determinism seams to the base**

```ts
// In RenderCore
protected deterministic = false;
setDeterministic(on: boolean): void { this.deterministic = on; }
setView(view: { rot?: { x: number; y: number }; zoom?: number; dpr?: number }): void {
  if (view.rot) this.rot = { ...view.rot };
  if (typeof view.zoom === "number") this.zoom = view.zoom;
  if (typeof view.dpr === "number") this.dpr = view.dpr; // harness fixes DPR
  this.requestImmediateFrame();
}
```

Gate idle auto-rotate and signal spawning on `!this.deterministic`:
- In the per-frame setup: `if (!this.drag && !this.deterministic && this.options.idleAutoRotate && now - this.lastUserAt > 1800) this.rot.y += 0.00065;`
- In `spawnSignals`: early-return when `this.deterministic` (no new signals; existing signals still animate from injected `now`).

- [ ] **Step 3: Make `BrainRenderer` extend `RenderCore`**

`renderer.ts` keeps only: `buildCloud` (cloud data) and the Canvas2D `drawScene(now)` (everything from today's `draw()` body *after* the shared setup: bg gradient, haze, cloud, edges, nodes, signals, labels, compass) plus its private draw helpers (`drawLobeHaze`, `drawCloudPoint`, `projectEdges`, `drawEdge`, `drawNode`, `drawSignals`, `drawLobeLabels`, `drawLobeLabel`, `drawLobeDot`, `drawNodeLabels`, `automaticLabelIds`, `maxAutomaticLabels`, `drawCompass`) and the module helpers `hexA`/`lerpHex`/`rgbaFromRgb`/`nodeRadius`. Output must be byte-identical to before.

- [ ] **Step 4: Repoint moved source-grep assertions**

`test/renderer-interaction.test.mjs` greps `../src/renderer.ts` for `PERFORMANCE_FRAME_DELAYS`, the `balanced/batterySaver/mobile` delays, `effectivePerformancePreset`, `maxDevicePixelRatio`, `scheduleNextFrame(0)`, `MAX_ZOOM = 6`, `hitTolerance`. These now live in `render-core.ts`. Update the test to read `../src/render-core.ts` for those (keep label/draw assertions pointed at `renderer.ts`). Split the `readFileSync` into `coreSource` and `rendererSource` as needed.

- [ ] **Step 5: Add determinism-seam unit test**

```js
// test/render-core.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const coreSource = readFileSync(new URL("../src/render-core.ts", import.meta.url), "utf8");

test("render-core exposes determinism seams used by the A/B harness", () => {
  assert.match(coreSource, /setDeterministic/);
  assert.match(coreSource, /setView/);
  assert.match(coreSource, /!this\.deterministic/); // auto-rotate + signal spawn gated
  assert.match(coreSource, /protected abstract drawScene/);
});
```

- [ ] **Step 6: Run tests and build**

Run: `npm test` → Expected: PASS (all existing suites green + new one).
Run: `npm run build` → Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/render-core.ts src/renderer.ts test/render-core.test.mjs test/renderer-interaction.test.mjs
git commit -m "refactor: extract RenderCore base with determinism seams"
```

---

## Task 3: Add the `rendererMode` setting

**Files:**
- Modify: `src/settings.ts`, `src/settings-tab.ts`
- Test: `test/settings.test.mjs`, `test/renderer-mode.test.mjs`

- [ ] **Step 1: Write the failing normalization test**

```js
// test/renderer-mode.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings.ts";

test("rendererMode defaults to auto and validates the enum", () => {
  assert.equal(DEFAULT_SETTINGS.rendererMode, "auto");
  assert.equal(normalizeSettings({ ...DEFAULT_SETTINGS, rendererMode: "webgl2" }).rendererMode, "webgl2");
  assert.equal(normalizeSettings({ ...DEFAULT_SETTINGS, rendererMode: "bogus" }).rendererMode, "auto");
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --test test/renderer-mode.test.mjs`
Expected: FAIL (`rendererMode` undefined).

- [ ] **Step 3: Implement in `settings.ts`**

```ts
export const RENDERER_MODES = ["auto", "webgl2", "canvas2d"] as const;
export type RendererMode = (typeof RENDERER_MODES)[number];
```
Add `rendererMode: RendererMode;` to the settings interface, `rendererMode: "auto"` to `DEFAULT_SETTINGS`, and in `normalizeSettings` clamp to the enum (fallback `"auto"`), mirroring how `performancePreset`/`palette` are normalized.

- [ ] **Step 4: Add the dropdown in `settings-tab.ts`**

Mirror the Performance-preset dropdown: a "Renderer" setting with options `auto` → "Auto (recommended)", `webgl2` → "WebGL2", `canvas2d` → "Canvas2D". Description: "Auto uses WebGL2 on desktop and Canvas2D on mobile. Force a renderer for testing or if WebGL has issues." On change, persist and trigger a view rebuild.

- [ ] **Step 5: Run tests + build**

Run: `npm test` → PASS. `npm run build` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/settings.ts src/settings-tab.ts test/renderer-mode.test.mjs test/settings.test.mjs
git commit -m "feat: add rendererMode setting (auto/webgl2/canvas2d)"
```

---

## Task 4: Stand up the A/B pixel-diff harness (against the Canvas2D reference)

Build the fidelity gate **before** the WebGL renderer exists. Initially it diffs the Canvas2D reference against itself (≈0), proving the harness is deterministic and giving WebGL a live target.

**Files:**
- Modify: `package.json`, `.github/workflows/ci.yml`
- Create: `test/ab/fixture-graph.mjs`, `test/ab/harness.html`, `test/ab/harness.mjs`, `test/ab/ab-fidelity.test.mjs`, `scripts/install-local.mjs`

- [ ] **Step 1: Add devDependencies and scripts**

```bash
npm install -D @playwright/test pixelmatch pngjs
npx playwright install --with-deps chromium
```
Add to `package.json` scripts: `"test:ab": "playwright test test/ab"`, `"install-local": "node scripts/install-local.mjs"`.

- [ ] **Step 2: Create a deterministic fixture graph**

`test/ab/fixture-graph.mjs` — export a function building a fixed `BrainGraph` (stable ids so `assignLobePositions`' `stableHash` layout is deterministic): a few hundred nodes across all 6 lobes, a mix of hub/non-hub, some `archived`/`dormantRelevant`, inter-lobe and intra-lobe edges, and an `activePalette` + `CHAOS`. Reuse adapter/classify/palette types. Keep counts modest so the diff is fast.

- [ ] **Step 3: Create the harness page + driver**

`test/ab/harness.html` loads an esbuild bundle of `test/ab/harness.mjs`. `harness.mjs` exposes `window.renderFrame({ renderer: "canvas2d"|"webgl2", palette, rot, zoom, dpr, focusId, hoverId, highlightLobe, width, height, now })` which:
1. builds the fixture graph with the requested palette,
2. constructs the requested renderer against freshly created canvas(es) sized `width×height` at the given `dpr`,
3. calls `setDeterministic(true)`, `setView({rot, zoom, dpr})`, applies focus/hover/highlight,
4. renders exactly one frame at `now`,
5. for WebGL, composites the overlay canvas onto a readback of the geometry canvas,
6. returns a PNG data URL of the composited result.

The Playwright build of the harness can `import` `../src/*.ts` (esbuild handles TS). Provide an `npm`-invoked esbuild step for the harness bundle, or let Playwright serve it via a tiny static server + on-the-fly esbuild.

- [ ] **Step 4: Write the harness self-check test**

`test/ab/ab-fidelity.test.mjs` (Playwright): for the matrix {each palette × a couple rot/zoom × {none, focus, hover, highlight}}, call `renderFrame({renderer:"canvas2d", …})` twice with identical inputs and assert `pixelmatch` diff == 0. This proves determinism. (After Task 11 it will compare canvas2d vs webgl2.)

```js
// shape (pseudocode)
const a = await page.evaluate(cfg => window.renderFrame(cfg), cfg);
const b = await page.evaluate(cfg => window.renderFrame(cfg), cfg);
const diff = pixelmatchDataUrls(a, b, { threshold: 0.1 });
assert.equal(diff.mismatchedPixels, 0);
```

- [ ] **Step 5: Run the harness locally**

Run: `npm run test:ab`
Expected: PASS (canvas2d vs canvas2d, 0 mismatched pixels across the matrix).

- [ ] **Step 6: Add `scripts/install-local.mjs`**

Build (`npm run build`) then copy `manifest.json`, `main.js`, `styles.css` into `${BRAIN_ATLAS_VAULT}/.obsidian/plugins/brain-atlas/` (read vault path from env var `BRAIN_ATLAS_VAULT`; error with guidance if unset). Do not commit any vault path.

- [ ] **Step 7: Wire the A/B job into CI**

Add a job to `.github/workflows/ci.yml` that runs after install: `npx playwright install --with-deps chromium` (cached) then `npm run test:ab`. Keep it a required check.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json test/ab scripts/install-local.mjs .github/workflows/ci.yml
git commit -m "test: add A/B pixel-diff harness (canvas2d self-check) + install-local"
```

---

## Task 5: WebGL pure-function foundations (TDD)

**Files:**
- Create: `src/gl/projection.ts`, `src/gl/color.ts`, `src/gl/buffers.ts`
- Test: `test/projection.test.mjs`, `test/gl-color.test.mjs`, `test/gl-buffers.test.mjs`

- [ ] **Step 1: `projection.ts` — failing test vs `makeProjector`**

```js
// test/projection.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { makeProjector } from "../src/shape.ts";
import { projectPoint } from "../src/gl/projection.ts";

test("projectPoint matches makeProjector for sample points (sx,sy,z,scale,depth)", () => {
  const opts = { rotX: -0.15, rotY: 0.55, scale: 120, cx: 200, cy: 180, dist: 3.4 };
  const cpu = makeProjector(opts);
  for (const p of [{x:0.2,y:-0.3,z:0.5},{x:-0.7,y:0.1,z:-0.4},{x:0,y:0,z:0}]) {
    const a = cpu(p); const b = projectPoint(opts, p);
    for (const k of ["sx","sy","z","scale","depth"]) assert.ok(Math.abs(a[k]-b[k]) < 1e-9, k);
  }
});
```

- [ ] **Step 2: Run → FAIL; implement `projectPoint` mirroring `shape.ts:113-141`**

Replicate `makeProjector` math exactly (note returned `scale = dist/(dist+z2)`, `depth = (z2+1.5)/3`). Export the per-frame inputs builder too: `sceneProjection(width,height,zoom,rot)` returning `{rotX,rotY,scale: Math.min(w,h)*0.32*zoom, cx: w/2, cy: h/2 - h*0.04, dist: 3.4}`.

- [ ] **Step 3: Run → PASS. Commit.**

```bash
git add src/gl/projection.ts test/projection.test.mjs
git commit -m "feat: add pure WebGL projection locked to makeProjector"
```

- [ ] **Step 4: `color.ts` — failing test vs `hexA` numerics**

Test that `hexToRgb01("#c9b896")` equals `[0xc9/255, 0xb8/255, 0x96/255]` and that `premultiply([r,g,b], a)` returns `[r*a,g*a,b*a, a]`.

- [ ] **Step 5: Run → FAIL; implement `hexToRgb01` + `premultiply`. Run → PASS. Commit.**

- [ ] **Step 6: `buffers.ts` — failing tests for vertex generation**

Test (no GL context): for the fixture graph, `buildEdgeRibbons(graph)` yields the right vertex count (per edge: 13 Bézier samples × ribbon width = 26 strip vertices, or your chosen layout), carries `flat` per-segment color-selector + per-segment depth-fade, the `sameLobe` flag, both endpoint `lobeIndex`es and node-indices, and `edge.A.color` for the focus override; control point is `(A+B)*0.35`. `buildCloudBuffer(cloud)` yields one entry per point with `lobeIndex`, `phase`, `freq`. `buildNodeBuffer(nodes)` carries radius inputs, status, `lobeIndex`, `node.color`, node-index. `incidentEdgeRanges(graph)` maps node-index → vertex ranges of incident edges.

- [ ] **Step 7: Run → FAIL; implement the pure builders (reference spec appendix for the Bézier + attributes). Run → PASS. Commit.**

```bash
git add src/gl/buffers.ts test/gl-buffers.test.mjs src/gl/color.ts test/gl-color.test.mjs
git commit -m "feat: add pure WebGL buffer + color builders"
```

---

## Task 6: WebGL renderer skeleton + background pass (first A/B comparison)

**Files:**
- Create: `src/gl/programs.ts`, `src/gl/shaders.ts`, `src/gl/brain-gl-renderer.ts`
- Modify: `test/ab/harness.mjs` (enable webgl2 path)

- [ ] **Step 1: `programs.ts` — compile/link/uniform helpers**

`createProgram(gl, vsSrc, fsSrc)`, `getUniforms(gl, program, names)`, `setUniformMatrix/Float/Int`, attribute binding helpers. All GL calls inside functions. (Pure-testable parts are thin; rely on the A/B gate for behavior.)

- [ ] **Step 2: `brain-gl-renderer.ts` — extends `RenderCore`, owns two canvases**

In `start(container, getGraph, options)`: create the WebGL canvas + overlay canvas inside `container` (overlay `pointer-events:none`, z above WebGL, below HUD). Get `webgl2` context with `{ alpha:false, antialias:false, premultipliedAlpha:true }`; if null, signal failure so the view falls back. Attach interaction listeners to the WebGL canvas; expose `getInteractionTarget()` returning it. Implement `resize()` to size **both** backing stores to `w*dpr × h*dpr` and set the overlay 2D transform. Implement `drawScene(now)`:
- compute `sceneProjection`, build the projection matrix uniform,
- bind framebuffer, `gl.clearColor` to background (or draw bg quad), set blend per pass,
- (this task) draw only the background gradient full-screen quad.

- [ ] **Step 3: Background fragment shader (premultiplied)**

`shaders.ts` bg shader reproduces the radial gradient: center `(cx,cy)`, radius `max(w,h)*0.75`, stops `bg @0 / bg @0.55 / bgFar @1`, interpolated in straight space, output premultiplied (`outRGB = rgb*1.0, outA = 1.0` since opaque). Confirm `{alpha:false}` so the canvas is opaque.

- [ ] **Step 4: Enable webgl2 in the harness and compare bg**

In `harness.mjs`, wire the `renderer:"webgl2"` branch. Add an A/B test case that renders only the background (a graph with no nodes/edges or a flag) for canvas2d vs webgl2 and asserts diff within tolerance.

- [ ] **Step 5: Run `npm run test:ab` → background matches. Commit.**

```bash
git add src/gl/programs.ts src/gl/shaders.ts src/gl/brain-gl-renderer.ts test/ab/harness.mjs
git commit -m "feat: WebGL renderer skeleton + background pass (A/B matches)"
```

---

## Tasks 7–11: Rendering passes (each gated by the A/B diff)

For each pass: implement the geometry upload + shader, add it to `drawScene` **in the exact draw order from the spec**, set the correct blend mode (additive = `blendFunc(ONE,ONE)`, source-over = `blendFunc(ONE,ONE_MINUS_SRC_ALPHA)`), output **premultiplied** color, then extend the A/B matrix to include that element and iterate until it passes within tolerance. Commit per pass. Use the spec **Numeric Fidelity Appendix** for every constant.

- [ ] **Task 7: Lobe haze** — additive quads per lobe center (+mirror), radial-falloff fragment shader with stops `baseA/baseA*0.45/0`, `baseA=(highlight===lobe?0.18:0.07)*depthFade*lobeMul`, `depthFade=max(0.25,1-depth*0.55)`, radius `r*sceneScale*1.4*pr.scale`, skip `<0.005`. Sorted by projected z. `uHighlightLobe` + `uLobeMul[6]` uniforms. A/B with highlight on/off. Commit.

- [ ] **Task 8: Point cloud** — static buffer; vertex shader projects + computes twinkle `0.65+0.35*sin(now*0.0005*freq+phase)`; far/near (sign of projected z) selects `alphaBase` (0.20/0.38) and radius (0.95/1.2); `alpha=(1-depth)*alphaBase*tw*lobeMul`; point-sprite quads with analytic ~1-device-px coverage; additive; drawn in two passes (z>0 before edges/nodes, z<=0 after). A/B. Commit.

- [ ] **Task 9: Edges** — ribbon triangle strips from `buffers.ts`; `flat` per-segment color selector (`sameLobe?cA:(seg<6?cA:cB)`, last-vertex provoking) and `flat` per-segment depth-fade (`1-midDepth*0.35`); centerline-distance coverage AA for sub-px `lineWidth` (0.55/0.7/1.3); alpha table via `uFocusNodeIndex`/`uHoverNodeIndex` lookup + `interBoost` (1.6 inter-lobe) + `lobeM=max(lobeMul A,B)`; **focus override**: whole edge uses `edge.A.color`. Edge-level z bucket + stable sort. A/B across base/hover/focus, intra/inter-lobe. Commit.

- [ ] **Task 10: Nodes** — per node: halo (radial, `0.32*alpha*CHAOS.bloom`→0, radius `radius*3.6*CHAOS.halo`), core (`min(1,alpha*0.93)`), white inner dot (`rgba(255,255,255,min(1,alpha))`, r `max(0.7,radius*0.42)`), hub ring (`radius+4`, 0.55α, lw 0.8) + crosshair (`±radius*3.2`, 0.45α). `radius = nodeRadius * max(0.55,scale) * (hover?1.18:focus?1.25:1)` (bumps from uniform index match); `fade=max(0.32,1-depth*0.75)`; status dim (archived 0.30 / dormant 0.55); `alpha<0.05` cull. Analytic coverage. A/B incl. hub-heavy + archived/dormant. Commit.

- [ ] **Task 11: Signals** — small **dynamic** buffer rebuilt each frame from the active signal list; 6 trailing sub-sprites with `t=max(0,tNorm-i*0.035)`, `lerpHex` color (match 0–255 rounding), `fade=(1-i/6)*envelope`, `depth=max(0.3,1-depth*0.6)`, radius `(1.3-i*0.15)*max(0.5,scale)`, halo `*3.2` @`0.22*…`, core @`0.55*…`. Additive. Because spawning is RNG-driven, A/B-test signals by injecting a fixed signal list via a test seam (e.g. `__setSignalsForTest`) so both renderers draw identical signals at a fixed `now`. Commit.

After Task 11: switch the Task-4 self-check matrix to compare **canvas2d vs webgl2** for every case; this is the real gate. Commit the harness update.

---

## Task 12: Overlay (labels + compass) on the Canvas2D overlay

**Files:** Modify `src/gl/brain-gl-renderer.ts`; reuse label/compass code.

- [ ] **Step 1:** From `drawScene`, after the WebGL passes, draw labels + compass onto the **overlay 2D context** by calling the existing `drawLobeLabels`/`drawNodeLabels`/`drawCompass` logic **verbatim** (extract these into a shared module callable with a 2D context, or duplicate the exact code). They must consume live `rot` (compass rebuilds its own projector with `dist=4`) and the same `automaticLabelIds`/`maxAutomaticLabels` (incl. mobile caps). No numeric changes.

- [ ] **Step 2:** A/B with labels enabled (`showLobeLabels: true`), hub nodes (auto-labels), focus (neighbor labels), and the compass. Iterate to within tolerance.

- [ ] **Step 3: Commit.**

```bash
git commit -am "feat: render labels + compass on the Canvas2D overlay (A/B matches)"
```

---

## Task 13: Renderer selection + `view.ts` wiring

**Files:** Modify `src/view.ts`.

- [ ] **Step 1:** Change `view.ts` to pass the **container** to the renderer (the renderer creates its canvas(es)). Implement selection: if `settings.rendererMode === "canvas2d"` → `BrainRenderer`; if `"webgl2"` → try `BrainGLRenderer`, fall back to `BrainRenderer` on context failure; if `"auto"` → mobile (`isMobileRuntime()`) → `BrainRenderer`, else try `BrainGLRenderer` with Canvas2D fallback.
- [ ] **Step 2:** Repoint `onCanvasClick`/`click` rect math and `localPoint` to `renderer.getInteractionTarget()` instead of `this.canvas`. Update `view-ux.test.mjs` greps that moved (`event.stopPropagation()`, `mode: "node"`, `consumeSuppressedClick`, `onPinNode`) to their new module (`render-core.ts`); leave `displayNodeName` (overlay label code) as-is.
- [ ] **Step 3:** `onShow`/`onHide`/`onClose` still call `start`/`stop`; rebuild renderer when `rendererMode` changes.
- [ ] **Step 4:** `npm test` + `npm run build` → green. Manual: open in Obsidian via `install-local`, toggle `rendererMode`. Commit.

```bash
git commit -am "feat: dual-renderer selection + container-owned canvases in view"
```

---

## Task 14: Node-drag partial buffer update + dynamic-state uniforms

**Files:** Modify `src/gl/brain-gl-renderer.ts`.

- [ ] **Step 1:** On node drag (`moveNodeTo` path), do **not** rebuild the whole edge buffer. Use the `incidentEdgeRanges` map: recompute only the dragged node's position + incident-edge ribbon vertices and `gl.bufferSubData` those ranges. Verify visually in Obsidian that dragging a hub stays smooth (no per-move full upload).
- [ ] **Step 2:** Confirm hover/focus/highlight/lobe-enable are **uniforms** (no rebuild) and palette change rebuilds **color** attributes only (not geometry). A/B the `daylight` palette specifically.
- [ ] **Step 3: Commit.**

```bash
git commit -am "perf: partial buffer update on drag; dynamic state via uniforms"
```

---

## Task 15: Context-loss handling + graceful unavailability

**Files:** Modify `src/gl/brain-gl-renderer.ts`, `src/view.ts`.

- [ ] **Step 1:** Handle `webglcontextlost` (preventDefault, pause RAF) and `webglcontextrestored` (recreate programs, re-upload buffers). If restore fails, signal the view to swap to `BrainRenderer`.
- [ ] **Step 2:** When no renderer can start (no WebGL2 *and* no 2D), show the existing `brain-atlas-empty` / `is-visible` overlay with a clear message — never throw through `onOpen`.
- [ ] **Step 3:** Manual: force `rendererMode: webgl2` on a context-killed canvas (DevTools "lose context") and confirm recovery / fallback. Commit.

```bash
git commit -am "feat: WebGL context-loss recovery + graceful fallback"
```

---

## Task 16: Release readiness

**Files:** Modify `README.md`, `versions.json`; final verification.

- [ ] **Step 1:** README: document the `Renderer` setting and that desktop uses WebGL2 for lower CPU while mobile/unsupported uses Canvas2D. Keep "Local-only rendering" wording.
- [ ] **Step 2:** `versions.json`: add the new release version → `1.5.0` (minAppVersion unchanged).
- [ ] **Step 3:** Full gate: `npm test` (unit + source), `npm run test:ab` (canvas2d vs webgl2 across the matrix), `npm run build`, `npm audit --omit=dev`. Grep `main.js` for `fetch|XMLHttpRequest|WebSocket|requestUrl|https://` (expect none new).
- [ ] **Step 4:** Manual checklist in real Obsidian via `install-local`: all palettes, focus/hover, hub nodes, signals in motion, lobe toggles + highlight, zoom extremes, node drag (incl. hub), idle auto-rotate, and forcing `canvas2d` — confirm no visible difference and smooth desktop CPU.
- [ ] **Step 5:** Open PR to `main`; ensure CI (incl. A/B job) is green; CODEOWNER review. Commit any doc fixes.

```bash
git commit -am "docs: document WebGL renderer + Renderer setting; bump versions.json"
```

---

## Notes for the implementer

- **Fidelity is gated by the A/B diff, not by eyeballing.** If a pass doesn't match, the bug is almost always: missing premultiply, wrong blend mode, interpolated instead of `flat` per-segment attribute, a dropped constant, or wrong draw order. Re-check against the spec appendix before touching tolerance.
- **Tolerance discipline:** set `pixelmatch` threshold + max-mismatched-pixels to ignore last-mile AA only. If you must loosen tolerance to pass, that's a smell — find the real difference first.
- **Never** add a runtime dependency. Playwright/pixelmatch/pngjs are `devDependencies` and must not appear in `main.js`.
- Keep `WebGL2RenderingContext` usage inside functions so `src/gl/*.ts` stay importable under `node --test`.
