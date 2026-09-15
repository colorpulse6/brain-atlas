import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rendererSource = readFileSync(new URL("../src/renderer.ts", import.meta.url), "utf8");

test("section labels follow showLobeLabels; node labels are always drawn (minimal by default)", () => {
  // Lobe/section labels stay gated by the toggle.
  assert.notEqual(rendererSource.indexOf("if (this.options.showLobeLabels) this.drawLobeLabels"), -1);
  // Node labels are NOT gated by showLobeLabels any more -- they always draw (minimal set: in-use/hover/focus).
  assert.equal(rendererSource.indexOf("if (this.options.showLobeLabels) this.drawNodeLabels"), -1);
  assert.notEqual(rendererSource.indexOf("this.drawNodeLabels(ctx, nodeProjs, graph, lobeMul)"), -1);
});
