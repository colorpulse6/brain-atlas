import assert from "node:assert/strict";
import test from "node:test";

import { rotationFromDrag, MAX_ROT_X } from "../src/render-core.ts";
import { Brain3D } from "../src/shape.ts";

const BASE = { scale: 300, cx: 400, cy: 300, dist: 3.4 };
const project = (rot) => Brain3D.makeProjector({ ...BASE, rotX: rot.x, rotY: rot.y });

// The projector's +z runs AWAY from the camera (f = scale / (dist + z) shrinks as
// z grows), so the surface nearest the viewer sits at negative z.
const FRONT = { x: 0, y: 0, z: -1 };
const BACK = { x: 0, y: 0, z: 1 };
const REST = { x: 0, y: 0 };

test("dragging right carries the near surface right, not the far one", () => {
  const rot = rotationFromDrag(REST, 90, 0);
  const before = project(REST);
  const after = project(rot);

  assert.ok(
    after(FRONT).sx > before(FRONT).sx,
    "the near surface must follow the cursor — moving it the other way is what makes the volume read as inside-out (#1)"
  );
  assert.ok(after(BACK).sx < before(BACK).sx, "the far surface travels opposite the cursor");
});

test("dragging down carries the near surface down", () => {
  const rot = rotationFromDrag(REST, 0, 90);
  const before = project(REST);
  const after = project(rot);

  assert.ok(after(FRONT).sy > before(FRONT).sy, "the near surface must follow the cursor vertically too");
});

test("dragging back to the start restores the original rotation", () => {
  const out = rotationFromDrag(REST, 120, -60);
  const back = rotationFromDrag(out, -120, 60);

  assert.ok(Math.abs(back.x - REST.x) < 1e-12);
  assert.ok(Math.abs(back.y - REST.y) < 1e-12);
});

test("vertical rotation stays clamped so the volume cannot tumble past vertical", () => {
  assert.equal(rotationFromDrag(REST, 0, 100_000).x, -MAX_ROT_X);
  assert.equal(rotationFromDrag(REST, 0, -100_000).x, MAX_ROT_X);
});

test("horizontal rotation is unclamped so the volume spins freely", () => {
  const spun = rotationFromDrag(REST, 100_000, 0);
  assert.ok(Math.abs(spun.y) > Math.PI * 2);
});
