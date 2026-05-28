import { CANONICAL_KINDS, type NodeKind } from "./types.ts";
import type { BrainAtlasSettings } from "./settings.ts";

export interface FileLike {
  path: string;
  basename: string;
}

export interface CacheLike {
  frontmatter?: Record<string, unknown>;
  tags?: string[];
}

export interface Classification {
  kind: NodeKind;
  source: "frontmatter" | "tag" | "folder" | "filename" | "fallback";
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

export function normalizeKind(value: unknown): NodeKind | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[-_\s]/g, "").toLowerCase();
  const direct = CANONICAL_KINDS.find((kind) => kind.toLowerCase() === normalized);
  return direct ?? KIND_SYNONYMS[normalized] ?? null;
}

export function classifyNote(
  file: FileLike,
  cache: CacheLike | null | undefined,
  settings: BrainAtlasSettings
): NodeKind {
  return classifyNoteDetailed(file, cache, settings).kind;
}

export function classifyNoteDetailed(
  file: FileLike,
  cache: CacheLike | null | undefined,
  settings: BrainAtlasSettings
): Classification {
  const frontmatter = cache?.frontmatter ?? {};
  for (const key of settings.frontmatterKindKeys) {
    const kind = normalizeKind(frontmatter[key]);
    if (kind) return { kind, source: "frontmatter" };
  }

  for (const rawTag of normalizedTags(cache)) {
    const mapped = settings.tagKindMap[rawTag];
    if (mapped) return { kind: mapped, source: "tag" };
  }

  for (const folder of folderAncestors(file.path)) {
    const mapped = settings.folderKindMap[folder] ?? settings.folderKindMap[folder.toLowerCase()];
    if (mapped) return { kind: mapped, source: "folder" };
  }

  const filenameKind = kindFromFilename(file.basename, settings);
  if (filenameKind) return { kind: filenameKind, source: "filename" };

  return { kind: "concept", source: "fallback" };
}

function normalizedTags(cache: CacheLike | null | undefined): string[] {
  const tags = cache?.tags ?? [];
  return tags
    .map((tag) => tag.replace(/^#/, "").trim().toLowerCase())
    .filter(Boolean);
}

function folderAncestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.flatMap((part) => [part, part.toLowerCase()]);
}

function kindFromFilename(basename: string, settings: BrainAtlasSettings): NodeKind | null {
  if (settings.treatDateFilesAsDaily && /^\d{4}-\d{2}-\d{2}/.test(basename)) {
    return "dailyNote";
  }

  const normalized = basename.trim().toLowerCase();
  if (/(^|[\s-])moc$/.test(normalized) || normalized.startsWith("map of ")) {
    return "concept";
  }
  if (["home", "index", "_readme", "readme"].includes(normalized)) {
    return "index";
  }

  return null;
}
