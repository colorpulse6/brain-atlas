import { CANONICAL_KINDS, type LobeName, type NodeKind } from "./types.ts";
import { allLobesEnabled, LOBES, normalizeLobeVisibility, type LobeVisibility } from "./lobe-visibility.ts";

export type ClickAction = "current" | "new-pane" | "hover-preview";
export type PaletteName = "graphite" | "ink" | "magma" | "bio" | "acid" | "aurora";

export interface PinnedNodePosition {
  x: number;
  y: number;
  z: number;
}

export interface BrainAtlasSettings {
  palette: PaletteName;
  frontmatterKindKeys: string[];
  tagKindMap: Record<string, NodeKind>;
  folderKindMap: Record<string, NodeKind>;
  frontmatterRegionKeys: string[];
  tagRegionMap: Record<string, LobeName>;
  noteRegionMap: Record<string, LobeName>;
  treatDateFilesAsDaily: boolean;
  honorDailyNotesFormat: boolean;
  dailyNoteDateFormat: string;
  nodeCap: number;
  edgeCap: number;
  idleAutoRotate: boolean;
  showLobeLabels: boolean;
  showLegendChip: boolean;
  enabledLobes: LobeVisibility;
  clickAction: ClickAction;
  hubThresholdPercent: number;
  pinnedNodePositions: Record<string, PinnedNodePosition>;
  defaultKind: NodeKind;
  inferKindsFromLinks: boolean;
}

export const DEFAULT_SETTINGS: BrainAtlasSettings = {
  palette: "graphite",
  frontmatterKindKeys: ["kind", "type", "category"],
  frontmatterRegionKeys: ["brain_region", "brainRegion", "lobe", "region"],
  tagKindMap: {
    project: "project",
    person: "person",
    decision: "decision",
    question: "question",
    tool: "tool",
    concept: "concept",
    source: "source",
    daily: "dailyNote",
    moc: "concept",
    thread: "workThread",
    index: "index"
  },
  folderKindMap: {
    People: "person",
    Projects: "project",
    Sources: "source",
    Daily: "dailyNote",
    Journal: "dailyNote",
    Concepts: "concept",
    Topics: "concept",
    MOCs: "concept",
    Maps: "concept",
    Index: "index",
    Home: "index"
  },
  tagRegionMap: {},
  noteRegionMap: {},
  treatDateFilesAsDaily: true,
  honorDailyNotesFormat: true,
  dailyNoteDateFormat: "YYYY-MM-DD",
  nodeCap: 1500,
  edgeCap: 4000,
  idleAutoRotate: true,
  showLobeLabels: true,
  showLegendChip: true,
  enabledLobes: allLobesEnabled(),
  clickAction: "current",
  hubThresholdPercent: 4,
  pinnedNodePositions: {},
  defaultKind: "concept",
  inferKindsFromLinks: true
};

export function normalizeSettings(input: Partial<BrainAtlasSettings> | null | undefined): BrainAtlasSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...(input ?? {}),
    frontmatterKindKeys: input?.frontmatterKindKeys ?? DEFAULT_SETTINGS.frontmatterKindKeys,
    frontmatterRegionKeys: input?.frontmatterRegionKeys ?? DEFAULT_SETTINGS.frontmatterRegionKeys,
    tagKindMap: normalizeKindMap(input?.tagKindMap, DEFAULT_SETTINGS.tagKindMap, true),
    folderKindMap: normalizeKindMap(input?.folderKindMap, DEFAULT_SETTINGS.folderKindMap, false),
    tagRegionMap: normalizeLobeMap(input?.tagRegionMap, DEFAULT_SETTINGS.tagRegionMap, true),
    noteRegionMap: normalizeLobeMap(input?.noteRegionMap, DEFAULT_SETTINGS.noteRegionMap, false),
    enabledLobes: normalizeLobeVisibility(input?.enabledLobes),
    pinnedNodePositions: normalizePinnedNodePositions(input?.pinnedNodePositions),
    defaultKind: normalizeKindValue(input?.defaultKind) ?? DEFAULT_SETTINGS.defaultKind,
    inferKindsFromLinks: input?.inferKindsFromLinks ?? DEFAULT_SETTINGS.inferKindsFromLinks
  };
}

export function normalizePinnedNodePositions(input: unknown): Record<string, PinnedNodePosition> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, PinnedNodePosition> = {};
  for (const [path, rawPosition] of Object.entries(input)) {
    if (!path || !rawPosition || typeof rawPosition !== "object" || Array.isArray(rawPosition)) continue;
    const position = rawPosition as Partial<PinnedNodePosition>;
    if (typeof position.x !== "number" || !Number.isFinite(position.x)) continue;
    if (typeof position.y !== "number" || !Number.isFinite(position.y)) continue;
    if (typeof position.z !== "number" || !Number.isFinite(position.z)) continue;
    out[path] = clampPinnedNodePosition(position as PinnedNodePosition);
  }
  return out;
}

export function clampPinnedNodePosition(position: PinnedNodePosition): PinnedNodePosition {
  return {
    x: clamp(position.x, -1.15, 1.15),
    y: clamp(position.y, -1.05, 0.98),
    z: clamp(position.z, -1.3, 1.3)
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeKindMap(
  input: unknown,
  defaults: Record<string, NodeKind>,
  lowercaseKeys: boolean
): Record<string, NodeKind> {
  const out: Record<string, NodeKind> = { ...defaults };
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [rawKey, rawKind] of Object.entries(input)) {
    const key = normalizeMapKey(rawKey, lowercaseKeys);
    const kind = normalizeKindValue(rawKind);
    if (!key || !kind) continue;
    out[key] = kind;
  }
  return out;
}

function normalizeLobeMap(
  input: unknown,
  defaults: Record<string, LobeName>,
  lowercaseKeys: boolean
): Record<string, LobeName> {
  const out: Record<string, LobeName> = { ...defaults };
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [rawKey, rawLobe] of Object.entries(input)) {
    const key = normalizeMapKey(rawKey, lowercaseKeys);
    const lobe = normalizeLobeValue(rawLobe);
    if (!key || !lobe) continue;
    out[key] = lobe;
  }
  return out;
}

function normalizeMapKey(value: string, lowercase: boolean): string {
  const trimmed = value.replace(/^#/, "").trim();
  return lowercase ? trimmed.toLowerCase() : trimmed;
}

function normalizeKindValue(value: unknown): NodeKind | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[-_\s]/g, "").toLowerCase();
  const direct = CANONICAL_KINDS.find((kind) => kind.toLowerCase() === normalized);
  return direct ?? KIND_SYNONYMS[normalized] ?? null;
}

export function normalizeLobeValue(value: unknown): LobeName | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[-_\s]/g, "").toLowerCase();
  if (normalized === "brainstem") return "stem";
  return LOBES.find((lobe) => lobe.toLowerCase() === normalized) ?? null;
}

const KIND_SYNONYMS: Record<string, NodeKind> = {
  daily: "dailyNote",
  dailynote: "dailyNote",
  journal: "dailyNote",
  thread: "workThread",
  workthread: "workThread",
  moc: "concept",
  map: "concept",
  org: "organization",
  organisation: "organization",
  company: "organization",
  repository: "repo",
  readme: "index"
};
