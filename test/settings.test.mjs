import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings.ts";

test("normalizeSettings preserves valid 3d pinned positions and drops invalid ones", () => {
  const settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    pinnedNodePositions: {
      "Projects/A.md": { x: 0.25, y: 0.5, z: -0.3 },
      "Concepts/Clamp.md": { x: -10, y: 10, z: 20 },
      "Bad/Number.md": { x: Number.NaN, y: 0.4, z: 0.1 },
      "Bad/Shape.md": "nope"
    }
  });

  assert.deepEqual(settings.pinnedNodePositions, {
    "Projects/A.md": { x: 0.25, y: 0.5, z: -0.3 },
    "Concepts/Clamp.md": { x: -1.15, y: 0.98, z: 1.3 }
  });
});

test("normalizeSettings validates editable categorization settings", () => {
  const settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    defaultKind: "person",
    inferKindsFromLinks: false,
    tagKindMap: {
      Area: "project",
      broken: "not-a-kind"
    },
    folderKindMap: {
      References: "source",
      BadFolder: "nope"
    }
  });

  assert.equal(settings.defaultKind, "person");
  assert.equal(settings.inferKindsFromLinks, false);
  assert.equal(settings.tagKindMap.area, "project");
  assert.equal(settings.tagKindMap.broken, undefined);
  assert.equal(settings.folderKindMap.References, "source");
  assert.equal(settings.folderKindMap.BadFolder, undefined);
});

test("normalizeSettings validates editable region override settings", () => {
  const settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    frontmatterRegionKeys: ["brain_region", "lobe"],
    tagRegionMap: {
      Focus: "frontal",
      broken: "not-a-region"
    },
    noteRegionMap: {
      "Concepts/A.md": "temporal",
      "Bad/Region.md": "nope"
    }
  });

  assert.deepEqual(settings.frontmatterRegionKeys, ["brain_region", "lobe"]);
  assert.equal(settings.tagRegionMap.focus, "frontal");
  assert.equal(settings.tagRegionMap.broken, undefined);
  assert.equal(settings.noteRegionMap["Concepts/A.md"], "temporal");
  assert.equal(settings.noteRegionMap["Bad/Region.md"], undefined);
});

test("normalizeSettings validates palette and performance settings", () => {
  const settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    palette: "daylight",
    performancePreset: "batterySaver"
  });

  assert.equal(settings.palette, "daylight");
  assert.equal(settings.performancePreset, "batterySaver");

  const fallback = normalizeSettings({
    ...DEFAULT_SETTINGS,
    palette: "not-a-palette",
    performancePreset: "turbo"
  });

  assert.equal(fallback.palette, "graphite");
  assert.equal(fallback.performancePreset, "smooth");
});

test("normalizeSettings validates frontmatter value and folder region mappings", () => {
  const settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    frontmatterKindValueMap: {
      "Type: Wiki": "source",
      "class:meeting": "workThread",
      "broken": "not-a-kind"
    },
    frontmatterRegionValueMap: {
      "type:person": "temporal",
      "type:wiki": "occipital",
      "bad": "not-a-region"
    },
    folderRegionMap: {
      Wiki: "occipital",
      Channels: "frontal",
      BadFolder: "nope"
    }
  });

  assert.equal(settings.frontmatterKindValueMap["type:wiki"], "source");
  assert.equal(settings.frontmatterKindValueMap["class:meeting"], "workThread");
  assert.equal(settings.frontmatterKindValueMap.broken, undefined);
  assert.equal(settings.frontmatterRegionValueMap["type:person"], "temporal");
  assert.equal(settings.frontmatterRegionValueMap["type:wiki"], "occipital");
  assert.equal(settings.frontmatterRegionValueMap.bad, undefined);
  assert.equal(settings.folderRegionMap.Wiki, "occipital");
  assert.equal(settings.folderRegionMap.Channels, "frontal");
  assert.equal(settings.folderRegionMap.BadFolder, undefined);
});
