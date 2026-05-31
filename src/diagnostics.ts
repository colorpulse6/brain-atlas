import type { App, CachedMetadata, TFile } from "obsidian";
import { classifyNoteDetailed, normalizeKind, resolveLobeOverride } from "./classify.ts";
import type { NoteInput } from "./adapter.ts";
import { KIND_TO_LOBE } from "./shape.ts";
import {
  frontmatterValueKeys,
  normalizeLobeValue,
  type BrainAtlasSettings
} from "./settings.ts";
import { LOBES } from "./lobe-visibility.ts";
import type { ClassificationSource, LobeName, LobeOverrideSource, NodeKind } from "./types.ts";

export interface UnmappedFrontmatterValue {
  key: string;
  field: string;
  value: string;
  count: number;
  examplePath: string;
  suggestedKindMapping: string;
  suggestedRegionMapping: string;
}

export interface ClassificationReport {
  totalNotes: number;
  regionCounts: Record<LobeName, number>;
  sourceCounts: Record<ClassificationSource, number>;
  lobeOverrideCounts: Record<LobeOverrideSource, number>;
  unmappedFrontmatterValues: UnmappedFrontmatterValue[];
}

export function buildClassificationReport(app: App, settings: BrainAtlasSettings): ClassificationReport {
  const notes = app.vault.getMarkdownFiles().map((file) => ({
    file: { path: file.path, basename: file.basename },
    cache: toCacheLike(app.metadataCache.getFileCache(file))
  }));
  return buildClassificationReportFromFiles(notes, settings);
}

export function buildClassificationReportFromFiles(notes: NoteInput[], settings: BrainAtlasSettings): ClassificationReport {
  const regionCounts = emptyRegionCounts();
  const sourceCounts = emptySourceCounts();
  const lobeOverrideCounts = emptyOverrideCounts();
  const unmapped = new Map<string, UnmappedFrontmatterValue>();

  for (const note of notes) {
    const classification = classifyNoteDetailed(note.file, note.cache, settings);
    const lobeOverride = resolveLobeOverride(note.file, note.cache, settings);
    const lobe = lobeOverride?.lobe ?? KIND_TO_LOBE[classification.kind] ?? "parietal";
    regionCounts[lobe] += 1;
    sourceCounts[classification.source] += 1;
    if (lobeOverride) lobeOverrideCounts[lobeOverride.source] += 1;
    collectUnmappedFrontmatterValues(unmapped, note, settings);
  }

  return {
    totalNotes: notes.length,
    regionCounts,
    sourceCounts,
    lobeOverrideCounts,
    unmappedFrontmatterValues: [...unmapped.values()]
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
      .slice(0, 12)
  };
}

function collectUnmappedFrontmatterValues(
  unmapped: Map<string, UnmappedFrontmatterValue>,
  note: NoteInput,
  settings: BrainAtlasSettings
): void {
  const frontmatter = note.cache?.frontmatter ?? {};
  const kindFields = new Set(settings.frontmatterKindKeys.map((field) => field.toLowerCase()));
  const regionFields = new Set(settings.frontmatterRegionKeys.map((field) => field.toLowerCase()));

  for (const [field, rawValue] of Object.entries(frontmatter)) {
    const normalizedField = field.toLowerCase();
    for (const key of frontmatterValueKeys(field, rawValue)) {
      if (settings.frontmatterKindValueMap[key] || settings.frontmatterRegionValueMap[key]) continue;
      const value = key.slice(key.indexOf(":") + 1);
      if (kindFields.has(normalizedField) && normalizeKind(value)) continue;
      if (regionFields.has(normalizedField) && normalizeLobeValue(value)) continue;

      const existing = unmapped.get(key);
      if (existing) {
        existing.count += 1;
        continue;
      }
      const suggestedKind = suggestKind(value);
      const suggestedRegion = KIND_TO_LOBE[suggestedKind] ?? "parietal";
      unmapped.set(key, {
        key,
        field: normalizedField,
        value,
        count: 1,
        examplePath: note.file.path,
        suggestedKindMapping: `${key}=${suggestedKind}`,
        suggestedRegionMapping: `${key}=${suggestedRegion}`
      });
    }
  }
}

function suggestKind(value: string): NodeKind {
  if (/person|people|author|contact|guest|client/.test(value)) return "person";
  if (/wiki|source|reference|article|book|paper|literature/.test(value)) return "source";
  if (/project|channel|video|episode|campaign/.test(value)) return "project";
  if (/meeting|sync|call|thread/.test(value)) return "workThread";
  if (/daily|journal|log/.test(value)) return "dailyNote";
  if (/index|moc|map|home/.test(value)) return "index";
  return "concept";
}

function emptyRegionCounts(): Record<LobeName, number> {
  return Object.fromEntries(LOBES.map((lobe) => [lobe, 0])) as Record<LobeName, number>;
}

function emptySourceCounts(): Record<ClassificationSource, number> {
  return {
    frontmatter: 0,
    tag: 0,
    folder: 0,
    filename: 0,
    linkBehavior: 0,
    default: 0
  };
}

function emptyOverrideCounts(): Record<LobeOverrideSource, number> {
  return {
    note: 0,
    frontmatter: 0,
    tag: 0,
    folder: 0
  };
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
