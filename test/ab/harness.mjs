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
 */

import { BrainRenderer } from "../../src/renderer.ts";
import { allLobesEnabled } from "../../src/lobe-visibility.ts";
import { buildFixtureGraph } from "./fixture-graph.mjs";

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
    now = 1000
  } = cfg;

  if (renderer === "webgl2") {
    // TODO: wire WebGL2 renderer here in a later task.
    throw new Error("webgl2 renderer not implemented yet");
  }

  if (renderer !== "canvas2d") {
    throw new Error(`Unknown renderer: ${renderer}`);
  }

  // Build a fresh graph for this palette (fully deterministic, no shared state).
  const graph = buildFixtureGraph(palette);

  // Create a canvas sized to the requested CSS dimensions.
  const canvas = document.createElement("canvas");
  // Set CSS style width/height so headless layout produces the correct rect;
  // resize() then sizes the backing store using forcedDpr.
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  document.body.appendChild(canvas);

  const r = new BrainRenderer();
  r.start(canvas, () => graph, {
    idleAutoRotate: true,
    showLobeLabels: true,
    enabledLobes: allLobesEnabled(),
    performancePreset: "smooth",
    mobileMode: false
  });

  // Apply determinism seams in order: deterministic first, then view, then overrides.
  r.setDeterministic(true);
  r.setView({ rot, zoom, dpr });

  if (highlightLobe) r.setHighlightLobe(highlightLobe);
  if (focusId) r.setFocusForTest(focusId);
  if (hoverId) r.setHoverForTest(hoverId);

  // Render exactly one frame synchronously at the injected timestamp.
  r.renderOnceForTest(now);

  const dataUrl = canvas.toDataURL("image/png");

  // Clean up so the DOM stays tidy between calls.
  r.stop();
  document.body.removeChild(canvas);

  return dataUrl;
};
