import type { App, CachedMetadata, TFile } from "obsidian";
import { classifyNoteDetailed, type CacheLike, type FileLike } from "./classify.ts";
import { KIND_LABEL, PALETTES, CHAOS } from "./palette.ts";
import { assignLobePositions } from "./shape.ts";
import type { BrainAtlasSettings } from "./settings.ts";
import type { BrainEdge, BrainGraph, BrainNode, NodeKind } from "./types.ts";

export interface NoteInput {
  file: FileLike;
  cache?: CacheLike & {
    links?: LinkLike[];
    embeds?: LinkLike[];
  };
}

export interface LinkLike {
  link: string;
}

interface DraftNode extends BrainNode {
  classificationSource: string;
}

export function buildGraphFromFiles(notes: NoteInput[], settings: BrainAtlasSettings): BrainGraph {
  const fileByPath = new Map(notes.map((note) => [note.file.path, note.file]));
  const pathByBasename = new Map(notes.map((note) => [note.file.basename.toLowerCase(), note.file.path]));
  const pathByName = new Map(notes.map((note) => [note.file.path.replace(/\.md$/i, "").toLowerCase(), note.file.path]));

  const edgeKeys = new Set<string>();
  for (const note of notes) {
    const outgoing = [...(note.cache?.links ?? []), ...(note.cache?.embeds ?? [])];
    for (const link of outgoing) {
      const targetPath = resolveLink(link.link, note.file.path, pathByBasename, pathByName, fileByPath);
      if (!targetPath || targetPath === note.file.path) continue;
      edgeKeys.add(edgeKey(note.file.path, targetPath));
    }
  }

  let edges = [...edgeKeys].map(edgeFromKey).sort(compareEdge);
  const degree = degreeByPath(edges);

  const palette = PALETTES[settings.palette] ?? PALETTES.graphite;
  let nodes: DraftNode[] = notes.map((note) => {
    const classification = classifyNoteDetailed(note.file, note.cache, settings);
    const linkedDegree = degree[note.file.path] ?? 0;
    const kind = applyLinkBehaviorFallback(classification.kind, classification.source, linkedDegree, note.file, edges);
    return {
      id: note.file.path,
      path: note.file.path,
      name: note.file.basename,
      title: note.file.basename,
      kind,
      kindLabel: KIND_LABEL[kind] ?? kind.toUpperCase(),
      status: "active",
      hub: false,
      degree: linkedDegree,
      color: palette.kinds[kind] ?? palette.kinds.unknown,
      classificationSource: classification.source
    };
  });

  nodes = markHubs(nodes, settings.hubThresholdPercent);
  nodes = capNodes(nodes, settings.nodeCap);
  const visible = new Set(nodes.map((node) => node.id));
  edges = edges.filter((edge) => visible.has(edge.a) && visible.has(edge.b));
  edges = capEdges(edges, nodes, settings.edgeCap);

  const cappedDegree = degreeByPath(edges);
  nodes = nodes.map((node) => ({
    ...node,
    degree: cappedDegree[node.id] ?? 0,
    color: palette.kinds[node.kind] ?? palette.kinds.unknown
  }));
  nodes = markHubs(nodes, settings.hubThresholdPercent);
  assignLobePositions(nodes);

  const idx = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const adj = adjacency(nodes, edges);
  return {
    nodes,
    edges,
    idx,
    adj,
    KIND_LABEL,
    activePalette: palette,
    activePaletteName: settings.palette,
    CHAOS
  };
}

export function buildGraph(app: App, settings: BrainAtlasSettings): BrainGraph {
  const notes = app.vault.getMarkdownFiles().map((file) => ({
    file: toFileLike(file),
    cache: toCacheLike(app.metadataCache.getFileCache(file))
  }));
  return buildGraphFromFiles(notes, settings);
}

function toFileLike(file: TFile): FileLike {
  return { path: file.path, basename: file.basename };
}

function toCacheLike(cache: CachedMetadata | null): NoteInput["cache"] {
  const frontmatterTags = cache?.frontmatter?.tags;
  const tags = [
    ...(cache?.tags?.map((tag) => tag.tag) ?? []),
    ...frontmatterTagList(frontmatterTags)
  ];
  return {
    frontmatter: cache?.frontmatter,
    tags,
    links: cache?.links?.map((link) => ({ link: link.link })) ?? [],
    embeds: cache?.embeds?.map((embed) => ({ link: embed.link })) ?? []
  };
}

function frontmatterTagList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/[,\s]+/).filter(Boolean);
  return [];
}

function resolveLink(
  rawLink: string,
  sourcePath: string,
  pathByBasename: Map<string, string>,
  pathByName: Map<string, string>,
  fileByPath: Map<string, FileLike>
): string | null {
  const link = rawLink.split("#")[0]?.split("^")[0]?.trim();
  if (!link) return null;
  const withExtension = link.endsWith(".md") ? link : `${link}.md`;
  if (fileByPath.has(withExtension)) return withExtension;

  const sourceFolder = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
  const sibling = sourceFolder ? `${sourceFolder}/${withExtension}` : withExtension;
  if (fileByPath.has(sibling)) return sibling;

  return pathByName.get(link.toLowerCase()) ?? pathByBasename.get(link.toLowerCase()) ?? null;
}

function edgeKey(a: string, b: string): string {
  return [a, b].sort((lhs, rhs) => lhs.localeCompare(rhs)).join("\u0000");
}

function edgeFromKey(key: string): BrainEdge {
  const [a, b] = key.split("\u0000");
  return { a, b };
}

function compareEdge(a: BrainEdge, b: BrainEdge): number {
  return a.a.localeCompare(b.a) || a.b.localeCompare(b.b);
}

function degreeByPath(edges: BrainEdge[]): Record<string, number> {
  const degree: Record<string, number> = {};
  for (const edge of edges) {
    degree[edge.a] = (degree[edge.a] ?? 0) + 1;
    degree[edge.b] = (degree[edge.b] ?? 0) + 1;
  }
  return degree;
}

function applyLinkBehaviorFallback(
  kind: NodeKind,
  source: string,
  degree: number,
  file: FileLike,
  edges: BrainEdge[]
): NodeKind {
  if (source !== "fallback") return kind;
  const inDegree = edges.filter((edge) => edge.b === file.path).length;
  const outDegree = edges.filter((edge) => edge.a === file.path).length;
  if (inDegree >= 8 && outDegree <= 2) return "index";
  if (outDegree >= 10 && inDegree <= 2) return "source";
  if (degree >= 12 && /index|home|map/i.test(file.basename)) return "index";
  return kind;
}

function markHubs<T extends BrainNode>(nodes: T[], thresholdPercent: number): T[] {
  if (!nodes.length) return nodes;
  const sortedDegrees = nodes.map((node) => node.degree).sort((a, b) => b - a);
  const percentileIndex = Math.max(0, Math.ceil(nodes.length * (thresholdPercent / 100)) - 1);
  const percentileDegree = sortedDegrees[percentileIndex] ?? 0;
  const threshold = Math.min(12, Math.max(1, percentileDegree));
  return nodes.map((node) => ({ ...node, hub: node.degree >= threshold }));
}

function capNodes<T extends BrainNode>(nodes: T[], cap: number): T[] {
  if (nodes.length <= cap) return nodes;
  return [...nodes]
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
    .slice(0, cap)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function capEdges(edges: BrainEdge[], nodes: BrainNode[], cap: number): BrainEdge[] {
  if (edges.length <= cap) return edges;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return [...edges]
    .sort((a, b) => {
      const aCross = nodeById.get(a.a)?.kind !== nodeById.get(a.b)?.kind ? 1 : 0;
      const bCross = nodeById.get(b.a)?.kind !== nodeById.get(b.b)?.kind ? 1 : 0;
      return aCross - bCross || compareEdge(a, b);
    })
    .slice(0, cap)
    .sort(compareEdge);
}

function adjacency(nodes: BrainNode[], edges: BrainEdge[]): Record<string, string[]> {
  const adj = Object.fromEntries(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    adj[edge.a]?.push(edge.b);
    adj[edge.b]?.push(edge.a);
  }
  return adj;
}
