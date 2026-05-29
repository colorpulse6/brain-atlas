import type { BrainNode } from "./types.ts";

const UUID_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DisplayNode = Pick<BrainNode, "id" | "name" | "path">;

export function displayNodeName(node: DisplayNode): string {
  const rawName = cleanName(node.name);
  if (rawName && !UUID_NAME_RE.test(rawName)) return rawName;

  const pathName = basename(node.path || node.id);
  if (pathName && !UUID_NAME_RE.test(pathName)) return pathName;

  return "Untitled note";
}

export function displayNodePath(node: DisplayNode): string {
  return node.path || node.id;
}

function cleanName(value: string): string {
  return value.trim();
}

function basename(path: string): string {
  const fileName = path.split(/[\\/]/).filter(Boolean).pop()?.trim() ?? "";
  return fileName.replace(/\.md$/i, "");
}
