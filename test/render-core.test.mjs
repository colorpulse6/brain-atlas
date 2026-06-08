import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const coreSource = readFileSync(new URL("../src/render-core.ts", import.meta.url), "utf8");

test("render-core exposes determinism seams used by the A/B harness", () => {
  assert.match(coreSource, /setDeterministic/);
  assert.match(coreSource, /setView/);
  assert.match(coreSource, /!this\.deterministic/);
  assert.match(coreSource, /protected abstract drawScene/);
});
