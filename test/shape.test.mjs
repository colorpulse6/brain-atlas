import assert from "node:assert/strict";
import test from "node:test";

import { assignLobePositions } from "../src/shape.ts";

function node(path) {
  return {
    id: path,
    path,
    name: path,
    title: path,
    kind: "concept",
    kindLabel: "CONCEPT",
    status: "active",
    hub: false,
    degree: 1,
    color: "#fff",
    classificationSource: "default"
  };
}

test("lobe assignment creates folder sub-clusters inside dense regions", () => {
  const nodes = [
    node("Wiki/A.md"),
    node("Wiki/B.md"),
    node("Channels/A.md"),
    node("Channels/B.md")
  ];

  assignLobePositions(nodes);

  const wikiDistance = distance(nodes[0]._3dLobe, nodes[1]._3dLobe);
  const crossDistance = distance(nodes[0]._3dLobe, nodes[2]._3dLobe);
  assert.ok(wikiDistance < crossDistance);
});

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
