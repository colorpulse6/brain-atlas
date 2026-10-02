import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rendererSource = readFileSync(new URL("../src/renderer.ts", import.meta.url), "utf8");

test("label setting gates lobe and node labels; live activity adds node labels for glowing notes", () => {
  assert.notEqual(rendererSource.indexOf("if (this.options.showLobeLabels) this.drawLobeLabels"), -1);
  assert.notEqual(rendererSource.indexOf("if (this.options.showLobeLabels || this.options.liveActivity) this.drawNodeLabels"), -1);
  assert.match(rendererSource, /activeIds: this\.options\.liveActivity \? this\.activeNoteIds\(\) : undefined/);
  assert.match(rendererSource, /showAll: this\.options\.showLobeLabels/);
});
