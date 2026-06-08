/**
 * Pure-function tests for src/gl/projection.ts.
 * Verifies that projectPoint reproduces makeProjector exactly and that
 * sceneProjection returns the expected camera parameters for a given
 * width/height/zoom/rot triple.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { makeProjector } from "../src/shape.ts";
import { projectPoint, sceneProjection } from "../src/gl/projection.ts";

const EPS = 1e-9;

function near(a, b, msg) {
  assert.ok(Math.abs(a - b) <= EPS, `${msg}: expected ${a} ≈ ${b} (diff=${Math.abs(a - b)})`);
}

const OPTS = {
  rotX: -0.15,
  rotY: 0.55,
  scale: 115.2,
  cx: 240,
  cy: 165.6,
  dist: 3.4
};

const SAMPLE_POINTS = [
  { x: 0, y: 0, z: 0 },
  { x: 0.65, y: -0.15, z: 0.10 },
  { x: -0.65, y: -0.15, z: 0.10 },
  { x: 0, y: 0.65, z: -0.10 },
  { x: 0, y: 0.20, z: 0.85 },
  { x: 0, y: -0.55, z: -0.78 },
  { x: 0, y: -0.85, z: -0.45 },
  { x: 0, y: 0.05, z: -0.95 },
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: 1 }
];

test("projectPoint matches makeProjector for all sample points within 1e-9", () => {
  const project = makeProjector(OPTS);
  for (const p of SAMPLE_POINTS) {
    const ref = project(p);
    const got = projectPoint(OPTS, p);
    near(got.sx, ref.sx, `sx for (${p.x},${p.y},${p.z})`);
    near(got.sy, ref.sy, `sy for (${p.x},${p.y},${p.z})`);
    near(got.z, ref.z, `z for (${p.x},${p.y},${p.z})`);
    near(got.scale, ref.scale, `scale for (${p.x},${p.y},${p.z})`);
    near(got.depth, ref.depth, `depth for (${p.x},${p.y},${p.z})`);
  }
});

test("projectPoint recomputes cos/sin per call and remains accurate", () => {
  // Use a different opts object each call to confirm no stale closure state.
  const optsA = { rotX: 0.3, rotY: -0.7, scale: 200, cx: 400, cy: 300, dist: 3.4 };
  const optsB = { rotX: -0.5, rotY: 1.2, scale: 90, cx: 100, cy: 80, dist: 3.4 };
  const refA = makeProjector(optsA);
  const refB = makeProjector(optsB);
  for (const p of SAMPLE_POINTS) {
    const gA = projectPoint(optsA, p);
    const rA = refA(p);
    near(gA.sx, rA.sx, "optsA sx");
    near(gA.sy, rA.sy, "optsA sy");

    const gB = projectPoint(optsB, p);
    const rB = refB(p);
    near(gB.sx, rB.sx, "optsB sx");
    near(gB.sy, rB.sy, "optsB sy");
  }
});

test("sceneProjection(480,360,1,{x:-0.15,y:0.55}) returns expected camera params", () => {
  const sp = sceneProjection(480, 360, 1, { x: -0.15, y: 0.55 });
  near(sp.scale, 115.2, "scale = min(480,360)*0.32*1");
  near(sp.cx, 240, "cx = 480/2");
  near(sp.cy, 165.6, "cy = 360/2 - 360*0.04");
  assert.equal(sp.dist, 3.4, "dist is always 3.4");
  near(sp.rotX, -0.15, "rotX from rot.x");
  near(sp.rotY, 0.55, "rotY from rot.y");
});

test("sceneProjection(800,600,2,{x:0,y:0}) returns zoomed scene params", () => {
  const sp = sceneProjection(800, 600, 2, { x: 0, y: 0 });
  near(sp.scale, Math.min(800, 600) * 0.32 * 2, "scale with zoom=2");
  near(sp.cx, 400, "cx");
  near(sp.cy, 300 - 600 * 0.04, "cy");
  assert.equal(sp.dist, 3.4);
});

test("sceneProjection combined with projectPoint matches full renderer pipeline", () => {
  // Simulate what draw() does: sceneProjection + projectPoint must equal makeProjector(draw opts).
  const width = 480, height = 360, zoom = 1.5;
  const rot = { x: 0.1, y: -0.3 };
  const sp = sceneProjection(width, height, zoom, rot);
  const ref = makeProjector({ rotX: sp.rotX, rotY: sp.rotY, scale: sp.scale, cx: sp.cx, cy: sp.cy, dist: sp.dist });
  for (const p of SAMPLE_POINTS) {
    const got = projectPoint(sp, p);
    const expected = ref(p);
    near(got.sx, expected.sx, "pipeline sx");
    near(got.sy, expected.sy, "pipeline sy");
    near(got.scale, expected.scale, "pipeline scale");
    near(got.depth, expected.depth, "pipeline depth");
  }
});
