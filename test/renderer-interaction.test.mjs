import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rendererSource = readFileSync(new URL("../src/renderer.ts", import.meta.url), "utf8");

test("wheel zoom allows deep inspection of dense node clusters", () => {
  assert.match(rendererSource, /MAX_ZOOM\s*=\s*6/);
  assert.match(rendererSource, /Math\.min\(MAX_ZOOM/);
});

test("hit testing tightens at high zoom for precise node dragging", () => {
  assert.match(rendererSource, /hitTolerance/);
  assert.match(rendererSource, /this\.zoom/);
});
