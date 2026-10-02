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

test("ambient animation drives the twinkle and ambient signals; live activity drives action signals", () => {
  // ambient inter-lobe signals follow the ambient toggle; action-driven signals follow live activity
  assert.match(coreSource, /!this\.deterministic && this\.options\.ambientAnimation && interLobeEdges\.length && now - this\.lastSpawn > 900/);
  assert.match(coreSource, /!this\.deterministic && this\.options\.liveActivity && this\.activity/);
  // both renderers freeze the twinkle clock the same way, so they still match pixel for pixel
  assert.match(canvasSource, /const twinkleClock = this\.options\.ambientAnimation \? now : 0;/);
  assert.match(glSource, /uTime, this\.options\.ambientAnimation \? now : 0\)/);
  assert.doesNotMatch(canvasSource + glSource, /liveActivity \? 0 : now/, "live activity no longer freezes the twinkle");
  // defaults: the classic animated brain, no live activity
  assert.match(coreSource, /liveActivity: false,\n\s*ambientAnimation: true,/);
  assert.match(coreSource, /idleAutoRotate: true,/);
});
