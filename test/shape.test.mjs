import assert from "node:assert/strict";
import test from "node:test";

import { assignLobePositions, placeLiveNode, liveLabelFootprint, liveFootprintsOverlap } from "../src/shape.ts";

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

test("live placement puts the two sides on opposite temporal faces", () => {
  const left = placeLiveNode("left", "git status", []);
  const right = placeLiveNode("right", "git status", []);
  assert.ok(left.x < 0 && right.x > 0);
  assert.equal(Math.sign(left.x), -Math.sign(right.x));
});

const LABELS = ["python evidence", "git status", "node", "powershell", "time.sleep(200)", "npm run build",
  "pytest", "docker compose", "head", "grep", "code-reviewer", "Explore", "git log --oneline", "echo",
  "python -m pytest", "cat"];

function placeMany(n) {
  const placed = [];
  for (let i = 0; i < n; i += 1) {
    const label = LABELS[i % LABELS.length];
    const p = placeLiveNode("right", label, placed.map((o) => ({ label: o.label, y: o.y, z: o.z })));
    placed.push({ label, ...p });
  }
  return placed;
}

test("no two live labels overlap, however many tasks arrive", () => {
  const placed = placeMany(16);
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = liveLabelFootprint(placed[i].label, placed[i].y, placed[i].z);
      const b = liveLabelFootprint(placed[j].label, placed[j].y, placed[j].z);
      assert.ok(!liveFootprintsOverlap(a, b), `${placed[i].label} overlaps ${placed[j].label}`);
    }
  }
});

test("a new task takes the nearest free spot, not a far corner", () => {
  const placed = placeMany(2);
  assert.ok(distance(placed[0], placed[1]) < 0.9, "second task should land right next to the first");
  const third = placeMany(3)[2];
  assert.ok(Math.abs(third.x - placed[0].x) < 1e-9, "same face");
});

test("a spot freed by an ended task is reused by the next arrival", () => {
  const [a, b, c] = placeMany(3);
  // b ends and fades out: only a and c occupy the face now
  const d = placeLiveNode("right", b.label, [a, c].map((o) => ({ label: o.label, y: o.y, z: o.z })));
  assert.ok(distance(d, b) < 1e-9, "the vacated spot is the nearest free one, so it is taken again");
});

test("live placement is deterministic and label length widens the footprint", () => {
  const occ = [{ label: "git status", y: 0.2, z: 0.1 }];
  assert.deepEqual(placeLiveNode("left", "npm run build", occ), placeLiveNode("left", "npm run build", occ));
  assert.ok(liveLabelFootprint("git log --oneline --graph", 0, 0).w > liveLabelFootprint("git", 0, 0).w);
});

test("live placement stays inside the temporal region for a normal load", () => {
  const placed = placeMany(12);
  for (const p of placed) {
    assert.ok(p.y > -1.2 && p.y < 0.8, `y in region: ${p.y}`);
    assert.ok(Math.abs(p.z - 0.10) < 1.2, `z in region: ${p.z}`);
  }
});

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
