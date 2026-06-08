/**
 * Deterministic fixture graph for the A/B pixel-diff harness.
 * Re-uses createDemoBrainGraph() from demo/sample-graph.ts (via the harness bundle).
 * This module is imported both by the harness (browser, bundled) and by the test (Node).
 *
 * In Node context the imports are resolved by the esbuild bundle step.
 * This file is ES module source — esbuild bundles it along with the TS sources.
 */

import { createDemoBrainGraph } from "../../demo/sample-graph.ts";
import { PALETTES } from "../../src/palette.ts";
export { FIXTURE_NODE_IDS } from "./fixture-ids.mjs";

/**
 * Build a fixture graph for the given palette name.
 * Colors on each node are re-derived from the chosen palette so that
 * rendering with e.g. "daylight" does not use graphite node colors.
 *
 * @param {string} paletteName - Key of PALETTES (e.g. "graphite", "daylight", "magma")
 * @returns {import("../../src/types.ts").BrainGraph}
 */
export function buildFixtureGraph(paletteName) {
  const graph = createDemoBrainGraph();
  const palette = PALETTES[paletteName];
  if (!palette) throw new Error(`Unknown palette: ${paletteName}`);

  graph.activePalette = palette;
  graph.activePaletteName = paletteName;

  // Re-derive each node's color from the chosen palette's kind map.
  for (const node of graph.nodes) {
    node.color = palette.kinds[node.kind] ?? palette.kinds["unknown"] ?? "#888888";
  }

  return graph;
}

