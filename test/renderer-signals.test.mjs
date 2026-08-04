import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const RENDERERS = [
  ["Canvas2D", "../src/renderer.ts"],
  ["WebGL2", "../src/gl/brain-gl-renderer.ts"]
];

// spawnSignals() and drawSignals() are a pair: the spawner is the only thing that
// ever pushes into the shared this.signals list, so a renderer that draws signals
// without spawning them animates nothing at all. The WebGL2 renderer shipped that
// way in 0.2.1 and the A/B harness could not catch it — it injects a fixed signal
// list via setSignalsForTest to stay deterministic, which bypasses spawnSignals.
for (const [name, path] of RENDERERS) {
  test(`${name} renderer spawns signals as well as drawing them`, () => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /this\.drawSignals\(/);
    assert.match(
      source,
      /this\.spawnSignals\(/,
      `${name} draws signals but never calls spawnSignals(), so this.signals stays empty and no pulse ever renders`
    );
  });
}
