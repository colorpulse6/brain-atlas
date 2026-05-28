import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rendererSource = readFileSync(new URL("../src/renderer.ts", import.meta.url), "utf8");

test("label setting gates both lobe labels and node labels", () => {
  assert.notEqual(rendererSource.indexOf("if (this.options.showLobeLabels) this.drawLobeLabels"), -1);
  assert.notEqual(rendererSource.indexOf("if (this.options.showLobeLabels) this.drawNodeLabels"), -1);
});
