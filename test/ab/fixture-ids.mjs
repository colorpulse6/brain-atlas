/**
 * Stable node IDs from the fixture graph, exported as a plain JS object with
 * no TypeScript dependencies so the Playwright test runner can import this
 * directly without esbuild bundling.
 *
 * These IDs must stay in sync with the GROUPS defined in demo/sample-graph.ts
 * and the FIXTURE_NODE_IDS exported from fixture-graph.mjs (which is bundled,
 * not imported directly by the test runner).
 */
export const FIXTURE_NODE_IDS = {
  // Hub nodes (index 0 of each group, hub=true)
  projectHub: "Demo Vault/Projects/Atlas launch.md",
  conceptHub: "Demo Vault/Concepts/Spatial memory.md",
  personHub: "Demo Vault/People/Avery Chen.md",
  sourceHub: "Demo Vault/Sources/Graph theory primer.md",
  dailyHub: "Demo Vault/Daily/2026-05-01.md",
  indexHub: "Demo Vault/Indexes/Home.md",
  // Non-hub nodes to test hover/focus rendering of non-hub nodes
  nonHub: "Demo Vault/Concepts/Attention loops.md",
  dormant: "Demo Vault/Projects/Mobile capture.md"
};
