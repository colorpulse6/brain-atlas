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

const glSource = readFileSync(new URL("../src/gl/brain-gl-renderer.ts", import.meta.url), "utf8");
const canvasSource = readFileSync(new URL("../src/renderer.ts", import.meta.url), "utf8");

test("live activity off keeps the classic animated brain: ambient signals and a twinkling cloud", () => {
  // ambient inter-lobe signals only when the feature is off; action-driven signals only when it is on
  assert.match(coreSource, /!this\.deterministic && !this\.options\.liveActivity && interLobeEdges\.length && now - this\.lastSpawn > 900/);
  assert.match(coreSource, /!this\.deterministic && this\.options\.liveActivity && this\.activity/);
  // both renderers freeze the twinkle clock the same way, so they still match pixel for pixel
  assert.match(canvasSource, /const twinkleClock = this\.options\.liveActivity \? 0 : now;/);
  assert.match(glSource, /uTime, this\.options\.liveActivity \? 0 : now\)/);
  assert.match(coreSource, /liveActivity: false,/);
  assert.match(coreSource, /idleAutoRotate: true,/);
});
