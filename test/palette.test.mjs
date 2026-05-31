import assert from "node:assert/strict";
import test from "node:test";

import { PALETTES } from "../src/palette.ts";

test("daylight palette provides a light renderer theme", () => {
  assert.equal(PALETTES.daylight.label, "DAYLIGHT");
  assert.equal(PALETTES.daylight.bg, "#f7f4ec");
  assert.equal(PALETTES.daylight.bgFar, "#e7dfd2");
});
