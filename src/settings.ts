import type { NodeKind } from "./types.ts";
import { allLobesEnabled, normalizeLobeVisibility, type LobeVisibility } from "./lobe-visibility.ts";

export type ClickAction = "current" | "new-pane" | "hover-preview";
export type PaletteName = "graphite" | "ink" | "magma" | "bio" | "acid" | "aurora";

export interface BrainAtlasSettings {
  palette: PaletteName;
  frontmatterKindKeys: string[];
  tagKindMap: Record<string, NodeKind>;
  folderKindMap: Record<string, NodeKind>;
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
}

export const DEFAULT_SETTINGS: BrainAtlasSettings = {
  palette: "graphite",
  frontmatterKindKeys: ["kind", "type", "category"],
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
  hubThresholdPercent: 4
};

export function normalizeSettings(input: Partial<BrainAtlasSettings> | null | undefined): BrainAtlasSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...(input ?? {}),
    frontmatterKindKeys: input?.frontmatterKindKeys ?? DEFAULT_SETTINGS.frontmatterKindKeys,
    tagKindMap: { ...DEFAULT_SETTINGS.tagKindMap, ...(input?.tagKindMap ?? {}) },
    folderKindMap: { ...DEFAULT_SETTINGS.folderKindMap, ...(input?.folderKindMap ?? {}) },
    enabledLobes: normalizeLobeVisibility(input?.enabledLobes)
  };
}
