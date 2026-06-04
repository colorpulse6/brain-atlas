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
 */

import { BrainRenderer } from "../../src/renderer.ts";
import { BrainGLRenderer } from "../../src/gl/brain-gl-renderer.ts";
import { allLobesEnabled } from "../../src/lobe-visibility.ts";
import { buildFixtureGraph } from "./fixture-graph.mjs";
import { assignLobePositions } from "../../src/shape.ts";

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
    signals = undefined
  } = cfg;

  if (renderer !== "canvas2d" && renderer !== "webgl2") {
    throw new Error(`Unknown renderer: ${renderer}`);
  }

  // Build a fresh graph for this palette (fully deterministic, no shared state).
  const graph = buildFixtureGraph(palette);

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
  r.start(canvas, () => graph, {
    idleAutoRotate: true,
    showLobeLabels: true,
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
