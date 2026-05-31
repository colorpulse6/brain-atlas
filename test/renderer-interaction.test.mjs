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

test("renderer keeps smooth as the default and supports opt-in idle frame caps", () => {
  assert.match(rendererSource, /performancePreset/);
  assert.match(rendererSource, /PERFORMANCE_FRAME_DELAYS/);
  assert.match(rendererSource, /balanced:\s*1000 \/ 30/);
  assert.match(rendererSource, /batterySaver:\s*1000 \/ 20/);
  assert.match(rendererSource, /scheduleNextFrame\(0\)/);
});

test("renderer caps automatic labels to avoid dense label smears", () => {
  assert.match(rendererSource, /automaticLabelIds/);
  assert.match(rendererSource, /maxAutomaticLabels/);
  assert.match(rendererSource, /focusNeighborLabelLimit/);
});
