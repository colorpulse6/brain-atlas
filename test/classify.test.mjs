import assert from "node:assert/strict";
import test from "node:test";

import { classifyNote, classifyNoteDetailed, normalizeKind } from "../src/classify.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";

function file(path) {
  const basename = path.split("/").pop().replace(/\.md$/i, "");
  return { path, basename };
}

test("frontmatter kind wins over tag and folder mappings", () => {
  const kind = classifyNote(
    file("People/Ada.md"),
    { frontmatter: { kind: "project" }, tags: ["#person"] },
    DEFAULT_SETTINGS
  );

  assert.equal(kind, "project");
});

test("folder mapping classifies notes when frontmatter and tags are absent", () => {
  const kind = classifyNote(file("Sources/Article.md"), {}, DEFAULT_SETTINGS);

  assert.equal(kind, "source");
});

test("daily date filenames classify as dailyNote", () => {
  const kind = classifyNote(file("Journal/2026-05-28.md"), {}, DEFAULT_SETTINGS);

  assert.equal(kind, "dailyNote");
});

test("kind synonyms normalize to canonical renderer kinds", () => {
  assert.equal(normalizeKind("daily"), "dailyNote");
  assert.equal(normalizeKind("thread"), "workThread");
  assert.equal(normalizeKind("org"), "organization");
});

test("uncategorized notes use the configured default kind", () => {
  const classification = classifyNoteDetailed(
    file("Notes/Loose thought.md"),
    {},
    { ...DEFAULT_SETTINGS, defaultKind: "project" }
  );

  assert.deepEqual(classification, { kind: "project", source: "default" });
});

test("custom tag and folder mappings classify notes", () => {
  assert.equal(
    classifyNote(
      file("Areas/Health.md"),
      { tags: ["#area"] },
      { ...DEFAULT_SETTINGS, tagKindMap: { area: "project" } }
    ),
    "project"
  );
  assert.equal(
    classifyNote(
      file("References/Book.md"),
      {},
      { ...DEFAULT_SETTINGS, folderKindMap: { References: "source" } }
    ),
    "source"
  );
});
