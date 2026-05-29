import assert from "node:assert/strict";
import test from "node:test";

import { displayNodeName } from "../src/node-display.ts";

test("keeps a readable note basename", () => {
  assert.equal(displayNodeName({ id: "Projects/Brain Atlas.md", name: "Brain Atlas", path: "Projects/Brain Atlas.md" }), "Brain Atlas");
});

test("falls back to the markdown path basename for unnamed nodes", () => {
  assert.equal(displayNodeName({ id: "People/Ada Lovelace.md", name: "", path: "People/Ada Lovelace.md" }), "Ada Lovelace");
});

test("prefers the path basename when a node name is a uuid", () => {
  assert.equal(
    displayNodeName({
      id: "13ed101b-7472-4a99-9dbe-9ac17f5ff75a/_profile.md",
      name: "13ed101b-7472-4a99-9dbe-9ac17f5ff75a",
      path: "13ed101b-7472-4a99-9dbe-9ac17f5ff75a/_profile.md"
    }),
    "_profile"
  );
});

test("uses a stable fallback when neither name nor path is readable", () => {
  assert.equal(displayNodeName({ id: "", name: "", path: "" }), "Untitled note");
});

test("uses a stable fallback when only a uuid is readable", () => {
  assert.equal(
    displayNodeName({
      id: "13ed101b-7472-4a99-9dbe-9ac17f5ff75a.md",
      name: "13ed101b-7472-4a99-9dbe-9ac17f5ff75a",
      path: "13ed101b-7472-4a99-9dbe-9ac17f5ff75a.md"
    }),
    "Untitled note"
  );
});
