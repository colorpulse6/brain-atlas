import assert from "node:assert/strict";
import test from "node:test";

import { buildGraphFromFiles } from "../src/adapter.ts";
import { buildClassificationReportFromFiles } from "../src/diagnostics.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { folderHeavyCreatorVault, frontmatterHeavyWikiVault } from "./fixtures/vaults.mjs";

test("folder-heavy creator vaults can spread broad folders across regions", () => {
  const graph = buildGraphFromFiles(folderHeavyCreatorVault(), {
    ...DEFAULT_SETTINGS,
    folderRegionMap: {
      Channels: "frontal",
      Wiki: "occipital",
      Inbox: "stem"
    }
  });

  assert.equal(graph.idx["Channels/Youtube/Brain Atlas Review.md"]._lobeName, "frontal");
  assert.equal(graph.idx["Wiki/Knowledge Graphs.md"]._lobeName, "occipital");
  assert.equal(graph.idx["Inbox/Loose Capture.md"]._lobeName, "stem");
});

test("frontmatter-heavy wiki vaults can map arbitrary values without renaming frontmatter", () => {
  const graph = buildGraphFromFiles(frontmatterHeavyWikiVault(), {
    ...DEFAULT_SETTINGS,
    frontmatterKindValueMap: {
      "type:wiki": "source",
      "type:person": "person",
      "class:meeting": "workThread"
    }
  });

  assert.equal(graph.idx["Articles/Zettelkasten.md"].kind, "source");
  assert.equal(graph.idx["Entities/Ada.md"].kind, "person");
  assert.equal(graph.idx["Meetings/Creator Sync.md"].kind, "workThread");
});

test("classification report identifies default-heavy regions and unmapped frontmatter values", () => {
  const report = buildClassificationReportFromFiles(frontmatterHeavyWikiVault(), DEFAULT_SETTINGS);

  assert.equal(report.totalNotes, 4);
  assert.equal(report.sourceCounts.default, 3);
  assert.equal(report.sourceCounts.frontmatter, 1);
  assert.equal(report.regionCounts.parietal, 3);
  assert.equal(report.regionCounts.temporal, 1);
  assert.deepEqual(
    report.unmappedFrontmatterValues.map((value) => value.key),
    ["type:wiki", "class:meeting"]
  );
  assert.equal(report.unmappedFrontmatterValues[0].count, 2);
  assert.equal(report.unmappedFrontmatterValues[0].suggestedKindMapping, "type:wiki=source");
  assert.equal(report.unmappedFrontmatterValues[0].suggestedRegionMapping, "type:wiki=occipital");
});
