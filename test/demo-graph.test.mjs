import assert from "node:assert/strict";
import test from "node:test";

import { createDemoBrainGraph } from "../demo/sample-graph.ts";
import { KIND_TO_LOBE } from "../src/shape.ts";

test("demo graph uses public-safe synthetic vault data", () => {
  const graph = createDemoBrainGraph();
  const serialized = JSON.stringify(graph);

  assert.ok(graph.nodes.length >= 120);
  assert.ok(graph.edges.length >= graph.nodes.length);
  assert.equal(serialized.includes("/Users/"), false);
  assert.equal(serialized.includes("nichalas"), false);
  assert.equal(serialized.includes("cerebro"), false);
  assert.equal(serialized.includes("kb/"), false);
  assert.ok(graph.nodes.every((node) => node.path.startsWith("Demo Vault/")));
});

test("demo graph includes every anatomical region with consistent indexes", () => {
  const graph = createDemoBrainGraph();
  const lobes = new Set(graph.nodes.map((node) => node._lobeName ?? KIND_TO_LOBE[node.kind]));

  assert.deepEqual([...lobes].sort(), ["cerebellum", "frontal", "occipital", "parietal", "stem", "temporal"]);
  assert.equal(Object.keys(graph.idx).length, graph.nodes.length);

  for (const edge of graph.edges) {
    assert.ok(graph.idx[edge.a]);
    assert.ok(graph.idx[edge.b]);
    assert.ok(graph.adj[edge.a]?.includes(edge.b));
    assert.ok(graph.adj[edge.b]?.includes(edge.a));
  }
});
