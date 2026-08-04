import type { App, CachedMetadata, TFile } from "obsidian";
import { classifyNoteDetailed, resolveLobeOverride, type CacheLike, type FileLike } from "./classify.ts";
import { KIND_LABEL, PALETTES, CHAOS } from "./palette.ts";
import { assignLobePositions } from "./shape.ts";
import type { BrainAtlasSettings, PinnedNodePosition } from "./settings.ts";
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

type DraftNode = BrainNode;

interface KindInference {
  kind: NodeKind;
  source: BrainNode["classificationSource"];
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
    const lobeOverride = resolveLobeOverride(note.file, note.cache, settings);
    const linkedDegree = degree[note.file.path] ?? 0;
    const inference = applyLinkBehaviorFallback(classification, linkedDegree, note.file, edges, settings);
    const kind = inference.kind;
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
      classificationSource: inference.source,
      lobeOverrideSource: lobeOverride?.source,
      _lobeName: lobeOverride?.lobe
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
  applyPinnedNodePositions(nodes, settings.pinnedNodePositions);

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
  const notes = app.vault
    .getMarkdownFiles()
    .filter((file) => !isUserIgnored(app, file.path))
    .map((file) => ({
      file: toFileLike(file),
      cache: toCacheLike(app.metadataCache.getFileCache(file))
    }));
  return buildGraphFromFiles(notes, settings);
}

/**
 * Obsidian never filters `Vault.getMarkdownFiles()` by the user's "Excluded files"
 * setting (Settings > Files & Links) - that list only hides files from the UI (file
 * explorer, quick switcher, search, core graph, etc). Plugins that walk the vault
 * themselves have to re-check each path against it, via the internal (undocumented)
 * `MetadataCache.isUserIgnored`, or ignored folders leak back into the atlas.
 *
 * Because that API carries no compatibility contract, neither a missing method nor a
 * throwing one may take the whole atlas down with it: `buildGraph` runs from
 * `BrainAtlasView.rebuild()` and `buildClassificationReport` from the settings tab,
 * both without a local catch, so an exception here would render a blank view instead
 * of a graph. Either failure degrades to "nothing is ignored" — the pre-0.2.2 behaviour.
 */
export function isUserIgnored(app: App, path: string): boolean {
  const metadataCache = app.metadataCache as App["metadataCache"] & {
    isUserIgnored?: (path: string) => boolean;
  };
  try {
    return metadataCache.isUserIgnored?.(path) ?? false;
  } catch (error) {
    warnUserIgnoredUnavailable(error);
    return false;
  }
}

let warnedUserIgnoredUnavailable = false;

/** Report the first failure only — this runs once per markdown file per rebuild. */
function warnUserIgnoredUnavailable(error: unknown): void {
  if (warnedUserIgnoredUnavailable) return;
  warnedUserIgnoredUnavailable = true;
  console.warn(
    "Brain Atlas: MetadataCache.isUserIgnored threw, so the Excluded files setting is being ignored for this session.",
    error
  );
}

/** Test-only: clear the warn-once latch so each test observes a fresh session. */
export function resetUserIgnoredWarningForTest(): void {
  warnedUserIgnoredUnavailable = false;
}

function toFileLike(file: TFile): FileLike {
  return { path: file.path, basename: file.basename };
}

function toCacheLike(cache: CachedMetadata | null): NoteInput["cache"] {
  const frontmatterTags: unknown = cache?.frontmatter?.tags;
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
  classification: { kind: NodeKind; source: BrainNode["classificationSource"] },
  degree: number,
  file: FileLike,
  edges: BrainEdge[],
  settings: BrainAtlasSettings
): KindInference {
  if (!settings.inferKindsFromLinks || classification.source !== "default") return classification;
  const inDegree = edges.filter((edge) => edge.b === file.path).length;
  const outDegree = edges.filter((edge) => edge.a === file.path).length;
  if (inDegree >= 8 && outDegree <= 2) return { kind: "index", source: "linkBehavior" };
  if (outDegree >= 10 && inDegree <= 2) return { kind: "source", source: "linkBehavior" };
  if (degree >= 12 && /index|home|map/i.test(file.basename)) return { kind: "index", source: "linkBehavior" };
  return classification;
}

function markHubs<T extends BrainNode>(nodes: T[], thresholdPercent: number): T[] {
  if (!nodes.length) return nodes;
  const percent = Math.max(0, Math.min(100, thresholdPercent));
  if (percent === 0) return nodes.map((node) => ({ ...node, hub: false }));
  const hubLimit = Math.max(1, Math.ceil(nodes.length * (percent / 100)));
  const hubIds = new Set(
    [...nodes]
      .filter((node) => node.degree > 0)
      .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
      .slice(0, hubLimit)
      .map((node) => node.id)
  );
  return nodes.map((node) => ({ ...node, hub: hubIds.has(node.id) }));
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

function applyPinnedNodePositions(nodes: BrainNode[], positions: Record<string, PinnedNodePosition>): void {
  for (const node of nodes) {
    const pinned = positions[node.id];
    if (!pinned) continue;
    node._3dLobe = { ...pinned };
  }
}
