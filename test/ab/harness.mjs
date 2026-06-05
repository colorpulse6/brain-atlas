/**
 * A/B pixel-diff harness page module.
 *
 * Bundled by esbuild into test/ab/harness.bundle.js and loaded by test/ab/harness.html.
 * Attaches window.renderFrame(cfg) for Playwright to call.
 *
 * cfg shape:
 *   renderer: "canvas2d" | "webgl2"
 *   palette:  string (key of PALETTES, e.g. "graphite")
 *   rot:      { x: number, y: number }
 *   zoom:     number
 *   dpr:      number
 *   focusId:  string | null
 *   hoverId:  string | null
 *   highlightLobe: string | null
 *   width:    number   (CSS pixels)
 *   height:   number   (CSS pixels)
 *   now:      number   (timestamp passed to renderOnceForTest)
 *   enabledPasses: string[] | undefined  (subset of passes to draw; undefined = all)
 *   signals:  Array<{aId, bId, born, dur, colA, colB}> | undefined
 *             Signal descriptors. aId/bId are node IDs in the fixture graph.
 *             Injected via setSignalsForTest so the signal pass is deterministic.
 *   presetPositions: Record<string, {x,y,z}> | undefined
 *             Node _3dLobe overrides applied BEFORE the first render (so the
 *             initial static buffer build already includes the moved position).
 *             Used for the "full build" reference path of the drag-equality test.
 *   moves:    Array<{id, position:{x,y,z}}> | undefined
 *             Node moves applied via moveNodeForTest AFTER an initial render has
 *             built the static buffers — this exercises the partial bufferSubData
 *             node-drag update path (onNodeMoved) rather than a full rebuild.
 */

import { BrainRenderer } from "../../src/renderer.ts";
import { BrainGLRenderer } from "../../src/gl/brain-gl-renderer.ts";
import { allLobesEnabled } from "../../src/lobe-visibility.ts";
import { buildFixtureGraph } from "./fixture-graph.mjs";
import { assignLobePositions } from "../../src/shape.ts";

/**
 * Expose the last created WebGL renderer for context-loss testing.
 * Populated by renderFrame when renderer="webgl2"; cleared to null otherwise.
 * @type {import("../../src/gl/brain-gl-renderer.ts").BrainGLRenderer | null}
 */
window._lastGLRenderer = null;

/**
 * Context-loss test session state. A persistent WebGL renderer that lives
 * across multiple page.evaluate calls so Playwright can drive lose/restore.
 */
window._contextLossSession = null;

/**
 * Start a persistent WebGL renderer session for context-loss testing.
 * Returns the initial rendered image as a PNG data URL (image A).
 * The session lives until contextLossSessionStop() is called.
 *
 * @param {object} cfg - subset of renderFrame config (palette, rot, zoom, dpr, width, height, now)
 * @returns {string} PNG data URL
 */
window.contextLossSessionStart = function contextLossSessionStart(cfg) {
  const {
    palette = "graphite",
    rot = { x: -0.15, y: 0.55 },
    zoom = 1,
    dpr = 1,
    width = 480,
    height = 360,
    now = 1000
  } = cfg;

  const graph = buildFixtureGraph(palette);
  assignLobePositions(graph.nodes);

  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.left = "0";
  container.style.top = "0";
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  document.body.appendChild(container);

  const canvas = document.createElement("canvas");
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  container.appendChild(canvas);

  const r = new BrainGLRenderer();
  r.start(canvas, () => graph, {
    idleAutoRotate: false,
    showLobeLabels: false,
    enabledLobes: allLobesEnabled(),
    performancePreset: "smooth",
    mobileMode: false
  });
  r.setDeterministic(true);
  r.setView({ rot, zoom, dpr });
  r.renderOnceForTest(now);
  if (r.raf != null) { cancelAnimationFrame(r.raf); r.raf = null; }

  // Capture image A (before any context loss).
  const result = document.createElement("canvas");
  result.width = canvas.width;
  result.height = canvas.height;
  const rctx = result.getContext("2d");
  rctx.drawImage(canvas, 0, 0);
  const overlay = r.getOverlayCanvasForTest();
  if (overlay) rctx.drawImage(overlay, 0, 0);
  const imageA = result.toDataURL("image/png");

  window._contextLossSession = { r, canvas, container, graph, rot, zoom, dpr, now };
  return imageA;
};

/**
 * Read whether the session renderer's context is currently marked as lost.
 * Use with page.waitForFunction to poll after loseContextForTest().
 * @returns {boolean}
 */
window.contextLossSessionIsLost = function contextLossSessionIsLost() {
  return window._contextLossSession?.r?.isContextLostForTest() ?? false;
};

/**
 * Read whether the session renderer has recovered (contextLost = false, isReady).
 * Use with page.waitForFunction to poll after restoreContextForTest().
 * @returns {boolean}
 */
window.contextLossSessionIsRestored = function contextLossSessionIsRestored() {
  const s = window._contextLossSession;
  if (!s) return false;
  return !s.r.isContextLostForTest();
};

/**
 * Trigger context loss on the session renderer via WEBGL_lose_context.
 */
window.contextLossSessionLose = function contextLossSessionLose() {
  window._contextLossSession?.r?.loseContextForTest();
};

/**
 * Trigger context restore on the session renderer via WEBGL_lose_context.
 */
window.contextLossSessionRestore = function contextLossSessionRestore() {
  window._contextLossSession?.r?.restoreContextForTest();
};

/**
 * Render a fresh frame after context restore and return the image as PNG data URL.
 * Call this after waitForFunction(contextLossSessionIsRestored).
 * @returns {string} PNG data URL
 */
window.contextLossSessionCaptureB = function contextLossSessionCaptureB() {
  const s = window._contextLossSession;
  if (!s) throw new Error("no active context-loss session");
  const { r, canvas } = s;

  // Cancel any pending RAF from the restore handler before our forced render.
  if (r.raf != null) { cancelAnimationFrame(r.raf); r.raf = null; }
  r.renderOnceForTest(s.now);

  const result = document.createElement("canvas");
  result.width = canvas.width;
  result.height = canvas.height;
  const rctx = result.getContext("2d");
  rctx.drawImage(canvas, 0, 0);
  const overlay = r.getOverlayCanvasForTest();
  if (overlay) rctx.drawImage(overlay, 0, 0);
  return result.toDataURL("image/png");
};

/**
 * Stop and clean up the context-loss session.
 */
window.contextLossSessionStop = function contextLossSessionStop() {
  const s = window._contextLossSession;
  if (!s) return;
  s.r.stop();
  if (s.container.parentElement) document.body.removeChild(s.container);
  window._contextLossSession = null;
};

/**
 * @param {object} cfg
 * @returns {string} PNG data URL
 */
window.renderFrame = function renderFrame(cfg) {
  const {
    renderer = "canvas2d",
    palette = "graphite",
    rot = { x: -0.15, y: 0.55 },
    zoom = 1,
    dpr = 1,
    focusId = null,
    hoverId = null,
    highlightLobe = null,
    width = 480,
    height = 360,
    now = 1000,
    enabledPasses = undefined,
    signals = undefined,
    showLobeLabels = true,
    presetPositions = undefined,
    moves = undefined
  } = cfg;

  if (renderer !== "canvas2d" && renderer !== "webgl2") {
    throw new Error(`Unknown renderer: ${renderer}`);
  }

  // Build a fresh graph for this palette (fully deterministic, no shared state).
  const graph = buildFixtureGraph(palette);

  // presetPositions: override node _3dLobe BEFORE start() so the initial static
  // buffer build already includes the moved position (the "full build" reference
  // path of the drag-equality test). Lobe positions must be assigned first so the
  // override survives ensureLobePositions (which only assigns if any node lacks it).
  if (presetPositions) {
    assignLobePositions(graph.nodes);
    for (const [id, p] of Object.entries(presetPositions)) {
      const node = graph.idx[id];
      if (!node) throw new Error(`harness: presetPositions id not found: ${id}`);
      node._3dLobe = { x: p.x, y: p.y, z: p.z };
    }
  }

  // A container gives the canvas a parent element so the WebGL renderer can
  // append its overlay canvas as a sibling. The container is positioned so the
  // absolutely-positioned overlay overlaps the canvas exactly.
  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.left = "0";
  container.style.top = "0";
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  document.body.appendChild(container);

  // Create a canvas sized to the requested CSS dimensions.
  const canvas = document.createElement("canvas");
  // Set CSS style width/height so headless layout produces the correct rect;
  // resize() then sizes the backing store using forcedDpr.
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  container.appendChild(canvas);

  const r = renderer === "webgl2" ? new BrainGLRenderer() : new BrainRenderer();
  // Expose the GL renderer for context-loss tests; clear for non-GL renders.
  window._lastGLRenderer = renderer === "webgl2" ? r : null;
  r.start(canvas, () => graph, {
    idleAutoRotate: true,
    showLobeLabels,
    enabledLobes: allLobesEnabled(),
    performancePreset: "smooth",
    mobileMode: false
  });

  // Restrict to a subset of passes if requested (undefined/null = all passes).
  r.setEnabledPassesForTest(enabledPasses ? new Set(enabledPasses) : null);

  // Apply determinism seams in order: deterministic first, then view, then overrides.
  r.setDeterministic(true);
  r.setView({ rot, zoom, dpr });

  if (highlightLobe) r.setHighlightLobe(highlightLobe);
  if (focusId) r.setFocusForTest(focusId);
  if (hoverId) r.setHoverForTest(hoverId);

  // Inject fixed signals if supplied. We resolve aId/bId to BrainNode objects
  // from the fixture graph (which has lobe positions assigned by start()).
  // Both renderers receive the SAME injected signal list so the signal pass is
  // deterministic and A/B-comparable at the fixed `now` timestamp.
  if (signals && signals.length > 0) {
    // Ensure lobe positions are assigned (start() → resize() → draw() assigns them;
    // but we need them before renderOnceForTest so the signal particles have _3dLobe).
    // start() calls resize() which triggers draw(), so by the time we reach here
    // positions may not be set yet (first frame hasn't run). Force assignment.
    assignLobePositions(graph.nodes);
    const particleList = signals.map((s, i) => {
      const a = graph.idx[s.aId];
      const b = graph.idx[s.bId];
      if (!a) throw new Error(`harness: signal aId not found: ${s.aId}`);
      if (!b) throw new Error(`harness: signal bId not found: ${s.bId}`);
      return {
        id: i,
        a,
        b,
        born: s.born,
        dur: s.dur,
        colA: s.colA ?? a.color,
        colB: s.colB ?? b.color
      };
    });
    r.setSignalsForTest(particleList);
  }

  // moves: exercise the partial node-drag buffer update. We must render ONCE
  // first so the static node + edge VBOs are built (cached by graph identity),
  // THEN apply moveNodeForTest (which fires onNodeMoved → partial bufferSubData),
  // so the final frame reflects the partial update rather than a fresh full build.
  if (moves && moves.length > 0) {
    assignLobePositions(graph.nodes); // ensure positions exist before the build render
    r.renderOnceForTest(now);         // build static buffers at ORIGINAL positions
    for (const m of moves) {
      if (!graph.idx[m.id]) throw new Error(`harness: move id not found: ${m.id}`);
      r.moveNodeForTest(m.id, m.position); // partial update path
    }
  }

  // Render exactly one frame synchronously at the injected timestamp.
  r.renderOnceForTest(now);

  let dataUrl;
  if (renderer === "webgl2") {
    // The returned image is the COMPOSITE: WebGL canvas (bottom) with the
    // overlay canvas (top) drawn over it. For Task 6 the overlay is empty, but
    // the composite is wired now for later text passes.
    const result = document.createElement("canvas");
    result.width = canvas.width;
    result.height = canvas.height;
    const rctx = result.getContext("2d");
    if (!rctx) throw new Error("harness: 2d context unavailable");
    rctx.drawImage(canvas, 0, 0);
    const overlay = r.getOverlayCanvasForTest();
    if (overlay) rctx.drawImage(overlay, 0, 0);
    dataUrl = result.toDataURL("image/png");
  } else {
    dataUrl = canvas.toDataURL("image/png");
  }

  // Clean up so the DOM stays tidy between calls.
  r.stop();
  document.body.removeChild(container);

  return dataUrl;
};
