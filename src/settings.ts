import { CANONICAL_KINDS, type LobeName, type NodeKind } from "./types.ts";
import { allLobesEnabled, LOBES, normalizeLobeVisibility, type LobeVisibility } from "./lobe-visibility.ts";

export type ClickAction = "current" | "new-pane" | "hover-preview";
export const PALETTE_NAMES = ["graphite", "ink", "magma", "bio", "acid", "aurora", "daylight"] as const;
export type PaletteName = (typeof PALETTE_NAMES)[number];
export const PERFORMANCE_PRESETS = ["smooth", "balanced", "batterySaver", "mobile"] as const;
export type PerformancePreset = (typeof PERFORMANCE_PRESETS)[number];
export const RENDERER_MODES = ["auto", "webgl2", "canvas2d"] as const;
export type RendererMode = (typeof RENDERER_MODES)[number];

export interface PinnedNodePosition {
  x: number;
  y: number;
  z: number;
}

export interface BrainAtlasSettings {
  palette: PaletteName;
  performancePreset: PerformancePreset;
  frontmatterKindKeys: string[];
  frontmatterKindValueMap: Record<string, NodeKind>;
  tagKindMap: Record<string, NodeKind>;
  folderKindMap: Record<string, NodeKind>;
  frontmatterRegionKeys: string[];
  frontmatterRegionValueMap: Record<string, LobeName>;
  tagRegionMap: Record<string, LobeName>;
  folderRegionMap: Record<string, LobeName>;
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
  rendererMode: RendererMode;
}

export const DEFAULT_SETTINGS: BrainAtlasSettings = {
  palette: "graphite",
  performancePreset: "smooth",
  frontmatterKindKeys: ["kind", "type", "category"],
  frontmatterKindValueMap: {},
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
  frontmatterRegionValueMap: {},
  tagRegionMap: {},
  folderRegionMap: {},
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
  inferKindsFromLinks: true,
  rendererMode: "auto"
};

export function normalizeSettings(input: Partial<BrainAtlasSettings> | null | undefined): BrainAtlasSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...(input ?? {}),
    frontmatterKindKeys: input?.frontmatterKindKeys ?? DEFAULT_SETTINGS.frontmatterKindKeys,
    frontmatterRegionKeys: input?.frontmatterRegionKeys ?? DEFAULT_SETTINGS.frontmatterRegionKeys,
    frontmatterKindValueMap: normalizeFrontmatterKindValueMap(input?.frontmatterKindValueMap, DEFAULT_SETTINGS.frontmatterKindValueMap),
    tagKindMap: normalizeKindMap(input?.tagKindMap, DEFAULT_SETTINGS.tagKindMap, true),
    folderKindMap: normalizeKindMap(input?.folderKindMap, DEFAULT_SETTINGS.folderKindMap, false),
    frontmatterRegionValueMap: normalizeFrontmatterLobeValueMap(
      input?.frontmatterRegionValueMap,
      DEFAULT_SETTINGS.frontmatterRegionValueMap
    ),
    tagRegionMap: normalizeLobeMap(input?.tagRegionMap, DEFAULT_SETTINGS.tagRegionMap, true),
    folderRegionMap: normalizeLobeMap(input?.folderRegionMap, DEFAULT_SETTINGS.folderRegionMap, false),
    noteRegionMap: normalizeLobeMap(input?.noteRegionMap, DEFAULT_SETTINGS.noteRegionMap, false),
    palette: normalizePaletteName(input?.palette) ?? DEFAULT_SETTINGS.palette,
    performancePreset: normalizePerformancePreset(input?.performancePreset) ?? DEFAULT_SETTINGS.performancePreset,
    enabledLobes: normalizeLobeVisibility(input?.enabledLobes),
    pinnedNodePositions: normalizePinnedNodePositions(input?.pinnedNodePositions),
    defaultKind: normalizeKindValue(input?.defaultKind) ?? DEFAULT_SETTINGS.defaultKind,
    inferKindsFromLinks: input?.inferKindsFromLinks ?? DEFAULT_SETTINGS.inferKindsFromLinks,
    rendererMode: normalizeRendererMode(input?.rendererMode) ?? DEFAULT_SETTINGS.rendererMode
  };
}

export function normalizeFrontmatterValueKey(value: string): string | null {
  const separator = value.indexOf(":");
  if (separator < 0) return null;
  const field = value.slice(0, separator).trim().toLowerCase();
  const rawValue = value.slice(separator + 1);
  const normalizedValue = normalizeFrontmatterScalar(rawValue);
  if (!field || !normalizedValue) return null;
  return `${field}:${normalizedValue}`;
}

export function frontmatterValueKeys(field: string, value: unknown): string[] {
  const normalizedField = field.trim().toLowerCase();
  if (!normalizedField) return [];
  return frontmatterValues(value).map((item) => `${normalizedField}:${item}`);
}

function normalizePaletteName(value: unknown): PaletteName | null {
  if (typeof value !== "string") return null;
  return (PALETTE_NAMES as readonly string[]).includes(value) ? value as PaletteName : null;
}

function normalizePerformancePreset(value: unknown): PerformancePreset | null {
  if (typeof value !== "string") return null;
  return (PERFORMANCE_PRESETS as readonly string[]).includes(value) ? value as PerformancePreset : null;
}

function normalizeRendererMode(value: unknown): RendererMode | null {
  if (typeof value !== "string") return null;
  return (RENDERER_MODES as readonly string[]).includes(value) ? value as RendererMode : null;
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

function normalizeFrontmatterKindValueMap(
  input: unknown,
  defaults: Record<string, NodeKind>
): Record<string, NodeKind> {
  const out: Record<string, NodeKind> = { ...defaults };
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [rawKey, rawKind] of Object.entries(input)) {
    const key = normalizeFrontmatterValueKey(rawKey);
    const kind = normalizeKindValue(rawKind);
    if (!key || !kind) continue;
    out[key] = kind;
  }
  return out;
}

function normalizeFrontmatterLobeValueMap(
  input: unknown,
  defaults: Record<string, LobeName>
): Record<string, LobeName> {
  const out: Record<string, LobeName> = { ...defaults };
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [rawKey, rawLobe] of Object.entries(input)) {
    const key = normalizeFrontmatterValueKey(rawKey);
    const lobe = normalizeLobeValue(rawLobe);
    if (!key || !lobe) continue;
    out[key] = lobe;
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

function frontmatterValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(frontmatterValues);
  const normalized = normalizeFrontmatterScalar(value);
  return normalized ? [normalized] : [];
}

function normalizeFrontmatterScalar(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).replace(/^#/, "").trim().toLowerCase();
  return normalized || null;
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
