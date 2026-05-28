import { assignLobePositions, KIND_TO_LOBE } from "../src/shape.ts";
import { CHAOS, KIND_LABEL, PALETTES } from "../src/palette.ts";
import type { BrainEdge, BrainGraph, BrainNode, NodeKind } from "../src/types.ts";

interface DemoGroup {
  kind: NodeKind;
  folder: string;
  names: string[];
}

const GROUPS: DemoGroup[] = [
  {
    kind: "project",
    folder: "Projects",
    names: [
      "Atlas launch", "Mobile capture", "Research map", "Release checklist", "Plugin store",
      "Reader mode", "Graph refresh", "Daily review", "Signal routing", "Design polish",
      "Search overlay", "Vault migration", "Team operating system", "Weekly planning",
      "Archive cleanup", "Writing pipeline", "Theme audit", "Beta feedback"
    ]
  },
  {
    kind: "concept",
    folder: "Concepts",
    names: [
      "Spatial memory", "Attention loops", "Metadata graph", "Idea gravity", "Knowledge routing",
      "Semantic clusters", "Context windows", "Visual hierarchy", "Network density", "Long term recall",
      "Atomic notes", "Progressive disclosure", "Memory palace", "Workbench rhythm", "Signal quality",
      "Graph affordances", "Note lifecycle", "Cognitive load", "Feedback loops", "Index design",
      "Retrieval practice", "Emergent structure", "Local first", "Vault privacy", "Map orientation",
      "Pattern library", "Research trail", "Source synthesis", "Decision logs", "Personal CRM"
    ]
  },
  {
    kind: "person",
    folder: "People",
    names: [
      "Avery Chen", "Mira Patel", "Jon Bell", "Nora Singh", "Elena Park", "Theo Morgan",
      "Sam Rivera", "Leah Stone", "Iris Grant", "Owen Reed", "Maya Lewis", "Noah Price",
      "Ada Brooks", "Kai Martin"
    ]
  },
  {
    kind: "source",
    folder: "Sources",
    names: [
      "Graph theory primer", "Interface notes", "Research digest", "Visualization paper",
      "Memory systems", "Knowledge tools", "Design critique", "Local app patterns",
      "Animation study", "Canvas performance", "Plugin policy", "Privacy review"
    ]
  },
  {
    kind: "dailyNote",
    folder: "Daily",
    names: [
      "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
      "2026-05-06", "2026-05-07", "2026-05-08", "2026-05-09", "2026-05-10",
      "2026-05-11", "2026-05-12", "2026-05-13", "2026-05-14", "2026-05-15",
      "2026-05-16", "2026-05-17", "2026-05-18"
    ]
  },
  {
    kind: "tool",
    folder: "Tools",
    names: [
      "Canvas renderer", "Metadata cache", "Hotkey map", "Release workflow", "Graph adapter",
      "Lobe classifier", "Screenshot harness", "Theme variables", "Settings panel", "Capture pipeline",
      "Search parser", "Issue template", "Review checklist", "Demo generator"
    ]
  },
  {
    kind: "repo",
    folder: "Repos",
    names: [
      "plugin source", "docs site", "theme lab", "capture scripts", "demo vault",
      "release notes", "test fixtures", "asset pipeline"
    ]
  },
  {
    kind: "incident",
    folder: "Incidents",
    names: [
      "Label overlap", "Frame budget", "Policy warning", "Release retry", "Search lag",
      "Viewport crop", "Cache miss", "Theme contrast"
    ]
  },
  {
    kind: "organization",
    folder: "Organizations",
    names: ["Obsidian community", "Design guild", "Research group", "Beta cohort", "Open source desk", "Publishing team"]
  },
  {
    kind: "index",
    folder: "Indexes",
    names: ["Home", "Projects index", "People index", "Sources index", "Daily index", "Brain Atlas map"]
  }
];

const CROSS_LINKS = [
  ["Projects/Atlas launch.md", "Concepts/Metadata graph.md"],
  ["Projects/Atlas launch.md", "Sources/Plugin policy.md"],
  ["Projects/Plugin store.md", "Sources/Privacy review.md"],
  ["Projects/Design polish.md", "Tools/Theme variables.md"],
  ["Projects/Search overlay.md", "Concepts/Retrieval practice.md"],
  ["Concepts/Local first.md", "Sources/Local app patterns.md"],
  ["Concepts/Vault privacy.md", "Sources/Privacy review.md"],
  ["Tools/Release workflow.md", "Repos/release notes.md"],
  ["Tools/Screenshot harness.md", "Repos/capture scripts.md"],
  ["Incidents/Policy warning.md", "Sources/Plugin policy.md"],
  ["Organizations/Obsidian community.md", "Projects/Plugin store.md"],
  ["Indexes/Home.md", "Projects/Atlas launch.md"],
  ["Indexes/Home.md", "Concepts/Metadata graph.md"],
  ["Indexes/Brain Atlas map.md", "Projects/Atlas launch.md"],
  ["Indexes/Brain Atlas map.md", "Tools/Canvas renderer.md"]
];

export function createDemoBrainGraph(): BrainGraph {
  const nodes: BrainNode[] = [];

  for (const group of GROUPS) {
    for (let index = 0; index < group.names.length; index += 1) {
      const name = group.names[index];
      nodes.push({
        id: `Demo Vault/${group.folder}/${name}.md`,
        name,
        title: name,
        kind: group.kind,
        kindLabel: KIND_LABEL[group.kind],
        status: index % 9 === 0 ? "dormantRelevant" : "active",
        hub: index === 0 || group.kind === "index",
        degree: 0,
        color: PALETTES.graphite.kinds[group.kind],
        path: `Demo Vault/${group.folder}/${name}.md`,
        _lobeName: KIND_TO_LOBE[group.kind]
      });
    }
  }

  assignLobePositions(nodes);

  const edges: BrainEdge[] = [];
  const edgeKeys = new Set<string>();
  const nodeIds = new Set(nodes.map((node) => node.id));

  const addEdge = (a: string, b: string): void => {
    if (a === b || !nodeIds.has(a) || !nodeIds.has(b)) return;
    const left = a < b ? a : b;
    const right = a < b ? b : a;
    const key = `${left}\n${right}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ a: left, b: right });
  };

  for (const group of GROUPS) {
    const groupNodes = nodes.filter((node) => node.kind === group.kind);
    const hub = groupNodes[0];
    if (!hub) continue;
    for (let index = 1; index < groupNodes.length; index += 1) {
      addEdge(hub.id, groupNodes[index].id);
      if (index > 1 && index % 3 === 0) addEdge(groupNodes[index - 1].id, groupNodes[index].id);
    }
  }

  for (const [a, b] of CROSS_LINKS) {
    addEdge(`Demo Vault/${a}`, `Demo Vault/${b}`);
  }

  for (let index = 0; index < nodes.length; index += 1) {
    const a = nodes[index];
    const b = nodes[(index * 7 + 13) % nodes.length];
    const c = nodes[(index * 11 + 29) % nodes.length];
    if (index % 2 === 0) addEdge(a.id, b.id);
    if (index % 5 === 0) addEdge(a.id, c.id);
  }

  const idx: Record<string, BrainNode> = {};
  const adj: Record<string, string[]> = {};
  for (const node of nodes) {
    idx[node.id] = node;
    adj[node.id] = [];
  }
  for (const edge of edges) {
    adj[edge.a].push(edge.b);
    adj[edge.b].push(edge.a);
  }
  for (const node of nodes) {
    node.degree = adj[node.id].length;
  }

  return {
    nodes,
    edges,
    idx,
    adj,
    KIND_LABEL,
    activePalette: PALETTES.graphite,
    activePaletteName: "graphite",
    CHAOS
  };
}
