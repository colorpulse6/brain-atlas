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
  const left = liveGridPosition("left", 0);
  const right = liveGridPosition("right", 0);
  assert.ok(left.x < 0, "left side has negative x");
  assert.ok(right.x > 0, "right side has positive x");
  assert.equal(Math.sign(left.x), -Math.sign(right.x));
});

test("live grid keeps slots well spread so labels don't overlap", () => {
  const points = [];
  for (let slot = 0; slot < 9; slot += 1) points.push(liveGridPosition("right", slot));
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      assert.ok(distance(points[i], points[j]) > 0.3, `slots ${i} and ${j} are too close`);
    }
  }
});

test("live grid slot position is stable and independent of how many tasks exist", () => {
  // A given slot always maps to the same point -> a running task never jumps as others come and go.
  assert.deepEqual(liveGridPosition("left", 3), liveGridPosition("left", 3));
  assert.deepEqual(liveGridPosition("right", 5), liveGridPosition("right", 5));
});

test("live grid grows downward as slots fill (new tasks spread, not stack)", () => {
  const s0 = liveGridPosition("right", 0);
  const s2 = liveGridPosition("right", 2); // next row (2 columns)
  assert.ok(s2.y < s0.y, "later rows sit lower");
});

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
