import assert from "node:assert/strict";
import test from "node:test";

import { assignLobePositions, placeLiveNode, liveLabelRect, liveRectsCollide, liveSpotClear, makeProjector, LIVE_CANON } from "../src/shape.ts";

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

test("layout spread 1 keeps the original layout: a note's spot does not depend on how full its region is", () => {
  const place = (count, spread) => {
    const nodes = [node("Wiki/Target.md")];
    for (let i = 0; i < count; i += 1) nodes.push(node(`Wiki/Filler ${i}.md`));
    assignLobePositions(nodes, spread);
    return nodes[0]._3dLobe;
  };
  // spread 1 (the default): the density factor is off, as in the layout before the spread setting existed
  assert.deepEqual(place(3, 1), place(300, 1));
  assert.deepEqual(place(3, undefined), place(3, 1));
  // above 1 a crowded region fans out further
  assert.notDeepEqual(place(3, 1.5), place(300, 1.5));
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

function placeMany(n, side = "right") {
  const placed = [];
  for (let i = 0; i < n; i += 1) {
    const label = LABELS[i % LABELS.length];
    const p = placeLiveNode(side, label, placed.map((o) => ({ label: o.label, x: o.x, y: o.y, z: o.z })));
    placed.push({ label, ...p });
  }
  return placed;
}

// The label box exactly as overlay-labels draws it: 10px mono (~6.2px/char) + 4px pad each side, 13px tall,
// starting radius+4 below the dot; the dot itself sits above it.
function drawnRect(label, pos, project) {
  return liveLabelRect(label, pos, project);
}

function framings() {
  const out = [];
  for (const scale of [200, 300]) {
    for (const rotY of [...LIVE_CANON.rotYs, 0.45]) {
      out.push({ scale, rotY, project: makeProjector({ rotX: LIVE_CANON.rotX, rotY, scale, cx: 0, cy: 0, dist: LIVE_CANON.dist }) });
    }
  }
  return out;
}

test("no two live labels overlap ON SCREEN at the reset framing (both faces, two pane sizes)", () => {
  for (const side of ["left", "right"]) {
    const placed = placeMany(14, side);
    for (const f of framings()) {
      for (let i = 0; i < placed.length; i += 1) {
        for (let j = i + 1; j < placed.length; j += 1) {
          const a = drawnRect(placed[i].label, placed[i], f.project);
          const b = drawnRect(placed[j].label, placed[j], f.project);
          assert.ok(!liveRectsCollide(a, b, 0),
            `${side}: "${placed[i].label}" overlaps "${placed[j].label}" at rotY ${f.rotY}, scale ${f.scale}`);
        }
      }
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
  const d = placeLiveNode("right", b.label, [a, c].map((o) => ({ label: o.label, x: o.x, y: o.y, z: o.z })));
  assert.ok(distance(d, b) < 1e-9, "the vacated spot is the nearest free one, so it is taken again");
});

test("live placement is deterministic and a longer label needs a wider box", () => {
  const occ = [{ label: "git status", y: 0.2, z: 0.1 }];
  assert.deepEqual(placeLiveNode("left", "npm run build", occ), placeLiveNode("left", "npm run build", occ));
  const pr = framings()[0].project;
  const wide = liveLabelRect("git log --oneline --graph", { x: 1.3, y: 0, z: 0 }, pr);
  const narrow = liveLabelRect("git", { x: 1.3, y: 0, z: 0 }, pr);
  assert.ok(wide.x1 - wide.x0 > narrow.x1 - narrow.x0);
});

test("a pinned spot that no longer reads clear is rejected, a clear one is kept", () => {
  const [a] = placeMany(1);
  const occ = [{ label: a.label, x: a.x, y: a.y, z: a.z }];
  assert.equal(liveSpotClear("python evidence", { x: a.x, y: a.y, z: a.z }, occ), false, "same spot collides");
  assert.equal(liveSpotClear("python evidence", { x: a.x, y: a.y - 0.05, z: a.z + 0.05 }, occ), false, "a nudge still collides");
  assert.equal(liveSpotClear("python evidence", { x: a.x, y: a.y - 0.6, z: a.z }, occ), true, "far below is clear");
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
