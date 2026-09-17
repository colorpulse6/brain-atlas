import assert from "node:assert/strict";
import test from "node:test";

import { assignLobePositions, liveGridPosition } from "../src/shape.ts";

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

test("live grid places the two sides on opposite temporal faces", () => {
  const left = liveGridPosition("left", 0, 4);
  const right = liveGridPosition("right", 0, 4);
  assert.ok(left.x < 0, "left side has negative x");
  assert.ok(right.x > 0, "right side has positive x");
  assert.equal(Math.sign(left.x), -Math.sign(right.x));
});

test("live grid keeps nodes on a side spread apart so labels don't overlap", () => {
  const total = 9;
  const points = [];
  for (let i = 0; i < total; i += 1) points.push(liveGridPosition("right", i, total));
  // no two slots collapse onto the same spot
  for (let i = 0; i < total; i += 1) {
    for (let j = i + 1; j < total; j += 1) {
      assert.ok(distance(points[i], points[j]) > 0.08, `slots ${i} and ${j} are too close`);
    }
  }
});

test("live grid is deterministic (same slot -> same point)", () => {
  assert.deepEqual(liveGridPosition("left", 3, 8), liveGridPosition("left", 3, 8));
});

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
