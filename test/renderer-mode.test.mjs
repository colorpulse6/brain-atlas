import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings.ts";

test("rendererMode defaults to auto and validates the enum", () => {
  assert.equal(DEFAULT_SETTINGS.rendererMode, "auto");
  assert.equal(normalizeSettings({ ...DEFAULT_SETTINGS, rendererMode: "webgl2" }).rendererMode, "webgl2");
  assert.equal(normalizeSettings({ ...DEFAULT_SETTINGS, rendererMode: "canvas2d" }).rendererMode, "canvas2d");
  assert.equal(normalizeSettings({ ...DEFAULT_SETTINGS, rendererMode: "bogus" }).rendererMode, "auto");
});
