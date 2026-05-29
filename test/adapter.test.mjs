import assert from "node:assert/strict";
import test from "node:test";

import { buildGraphFromFiles } from "../src/adapter.ts";
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
