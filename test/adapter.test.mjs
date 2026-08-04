import assert from "node:assert/strict";
import test from "node:test";

import { buildGraph, buildGraphFromFiles, isUserIgnored } from "../src/adapter.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";

function note(path, cache = {}) {
  return {
    file: { path, basename: path.split("/").pop().replace(/\.md$/i, "") },
    cache
  };
}

test("buildGraphFromFiles resolves wikilinks into deduped undirected edges", () => {
  const graph = buildGraphFromFiles(
    [
      note("Projects/Brain Atlas.md", { links: [{ link: "Ada" }, { link: "Ada" }] }),
      note("People/Ada.md", {})
    ],
    DEFAULT_SETTINGS
  );

  assert.equal(graph.nodes.length, 2);
  assert.deepEqual(graph.edges, [{ a: "People/Ada.md", b: "Projects/Brain Atlas.md" }]);
  assert.equal(graph.idx["Projects/Brain Atlas.md"].degree, 1);
});

test("buildGraphFromFiles caps nodes by keeping highest-degree notes", () => {
  const graph = buildGraphFromFiles(
    [
      note("Projects/Hub.md", { links: [{ link: "A" }, { link: "B" }, { link: "C" }] }),
      note("Concepts/A.md", {}),
      note("Concepts/B.md", {}),
      note("Concepts/C.md", {})
    ],
    { ...DEFAULT_SETTINGS, nodeCap: 2, edgeCap: 10 }
  );

  assert.deepEqual(
    graph.nodes.map((node) => node.id).sort(),
    ["Concepts/A.md", "Projects/Hub.md"]
  );
  assert.equal(graph.edges.length, 1);
});

test("buildGraphFromFiles applies persisted pinned node positions", () => {
  const graph = buildGraphFromFiles(
    [
      note("Projects/Brain Atlas.md", { links: [{ link: "Ada" }] }),
      note("People/Ada.md", {})
    ],
    {
      ...DEFAULT_SETTINGS,
      pinnedNodePositions: {
        "Projects/Brain Atlas.md": { x: 0.12, y: 0.34, z: -0.56 }
      }
    }
  );

  assert.deepEqual(graph.idx["Projects/Brain Atlas.md"]._3dLobe, { x: 0.12, y: 0.34, z: -0.56 });
});

test("buildGraphFromFiles can disable link-behavior category inference", () => {
  const graph = buildGraphFromFiles(
    [
      note("Notes/Hub.md", {
        links: Array.from({ length: 12 }, (_, index) => ({ link: `Target ${index}` }))
      }),
      ...Array.from({ length: 12 }, (_, index) => note(`Notes/Target ${index}.md`, {}))
    ],
    { ...DEFAULT_SETTINGS, inferKindsFromLinks: false, defaultKind: "concept" }
  );

  assert.equal(graph.idx["Notes/Hub.md"].kind, "concept");
});

test("buildGraphFromFiles applies note, frontmatter, and tag region overrides", () => {
  const graph = buildGraphFromFiles(
    [
      note("Concepts/Exact.md", {
        frontmatter: { brain_region: "occipital" },
        tags: ["#focus"]
      }),
      note("Concepts/Frontmatter.md", {
        frontmatter: { brain_region: "temporal" },
        tags: ["#focus"]
      }),
      note("Concepts/Tagged.md", {
        tags: ["#focus"]
      })
    ],
    {
      ...DEFAULT_SETTINGS,
      tagRegionMap: { focus: "frontal" },
      noteRegionMap: { "Concepts/Exact.md": "stem" }
    }
  );

  assert.equal(graph.idx["Concepts/Exact.md"].kind, "concept");
  assert.equal(graph.idx["Concepts/Exact.md"]._lobeName, "stem");
  assert.equal(graph.idx["Concepts/Exact.md"].lobeOverrideSource, "note");
  assert.equal(graph.idx["Concepts/Frontmatter.md"]._lobeName, "temporal");
  assert.equal(graph.idx["Concepts/Frontmatter.md"].lobeOverrideSource, "frontmatter");
  assert.equal(graph.idx["Concepts/Tagged.md"]._lobeName, "frontal");
  assert.equal(graph.idx["Concepts/Tagged.md"].lobeOverrideSource, "tag");
});

test("buildGraphFromFiles applies frontmatter value and folder region overrides", () => {
  const graph = buildGraphFromFiles(
    [
      note("Wiki/Retention.md", {
        frontmatter: { type: "wiki" }
      }),
      note("Channels/Youtube/Script.md", {})
    ],
    {
      ...DEFAULT_SETTINGS,
      frontmatterKindValueMap: {
        "type:wiki": "source"
      },
      frontmatterRegionValueMap: {
        "type:wiki": "occipital"
      },
      folderRegionMap: {
        Channels: "frontal"
      }
    }
  );

  assert.equal(graph.idx["Wiki/Retention.md"].kind, "source");
  assert.equal(graph.idx["Wiki/Retention.md"]._lobeName, "occipital");
  assert.equal(graph.idx["Wiki/Retention.md"].lobeOverrideSource, "frontmatter");
  assert.equal(graph.idx["Channels/Youtube/Script.md"].kind, "concept");
  assert.equal(graph.idx["Channels/Youtube/Script.md"]._lobeName, "frontal");
  assert.equal(graph.idx["Channels/Youtube/Script.md"].lobeOverrideSource, "folder");
});

test("buildGraphFromFiles limits hubs to the configured top percentage when degrees tie", () => {
  const notes = [];
  for (let index = 0; index < 20; index += 2) {
    notes.push(note(`Notes/Node ${index}.md`, { links: [{ link: `Node ${index + 1}` }] }));
    notes.push(note(`Notes/Node ${index + 1}.md`, {}));
  }

  const graph = buildGraphFromFiles(notes, { ...DEFAULT_SETTINGS, hubThresholdPercent: 10 });

  assert.equal(graph.nodes.filter((node) => node.hub).length, 2);
});

function fakeApp(files, ignoredPaths = []) {
  const ignored = new Set(ignoredPaths);
  return {
    vault: {
      getMarkdownFiles: () => files
    },
    metadataCache: {
      getFileCache: () => ({}),
      isUserIgnored: (path) => ignored.has(path)
    }
  };
}

test("buildGraph drops notes that live under Obsidian's Excluded files patterns", () => {
  const files = [
    { path: "Projects/Keep.md", basename: "Keep" },
    { path: "Archive/Skip.md", basename: "Skip" }
  ];
  const app = fakeApp(files, ["Archive/Skip.md"]);

  const graph = buildGraph(app, DEFAULT_SETTINGS);

  assert.deepEqual(graph.nodes.map((node) => node.id), ["Projects/Keep.md"]);
});

test("isUserIgnored treats a missing internal API as not-ignored", () => {
  assert.equal(isUserIgnored({ metadataCache: {} }, "Anything.md"), false);
});
