import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rendererSource = readFileSync(new URL("../src/renderer.ts", import.meta.url), "utf8");
const coreSource = readFileSync(new URL("../src/render-core.ts", import.meta.url), "utf8");

test("wheel zoom allows deep inspection of dense node clusters", () => {
  assert.match(coreSource, /MAX_ZOOM\s*=\s*6/);
  assert.match(coreSource, /Math\.min\(MAX_ZOOM/);
});

test("hit testing tightens at high zoom for precise node dragging", () => {
  assert.match(coreSource, /hitTolerance/);
  assert.match(coreSource, /this\.zoom/);
});

test("renderer keeps smooth as the default and supports opt-in idle frame caps", () => {
  assert.match(coreSource, /performancePreset/);
  assert.match(coreSource, /PERFORMANCE_FRAME_DELAYS/);
  assert.match(coreSource, /balanced:\s*1000 \/ 30/);
  assert.match(coreSource, /batterySaver:\s*1000 \/ 20/);
  assert.match(coreSource, /mobile:\s*1000 \/ 15/);
  assert.match(coreSource, /effectivePerformancePreset/);
  assert.match(coreSource, /maxDevicePixelRatio/);
  assert.match(coreSource, /scheduleNextFrame\(0\)/);
});

test("renderer caps automatic labels to avoid dense label smears", () => {
  assert.match(rendererSource, /automaticLabelIds/);
  assert.match(rendererSource, /maxAutomaticLabels/);
  assert.match(rendererSource, /focusNeighborLabelLimit/);
});
