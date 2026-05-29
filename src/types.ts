export const CANONICAL_KINDS = [
  "person",
  "project",
  "concept",
  "decision",
  "question",
  "tool",
  "workThread",
  "dailyNote",
  "source",
  "repo",
  "incident",
  "organization",
  "index",
  "unknown"
] as const;

export type NodeKind = (typeof CANONICAL_KINDS)[number];

export type LobeName =
  | "frontal"
  | "parietal"
  | "temporal"
  | "occipital"
  | "cerebellum"
  | "stem";

export type ClassificationSource = "frontmatter" | "tag" | "folder" | "filename" | "linkBehavior" | "default";

export interface BrainNode {
  id: string;
  name: string;
  title: string;
  kind: NodeKind;
  kindLabel: string;
  status: "active" | "dormantRelevant" | "archived";
  hub: boolean;
  degree: number;
  color: string;
  path: string;
  classificationSource: ClassificationSource;
  _3dLobe?: Vec3;
  _lobeName?: LobeName;
}

export interface BrainEdge {
  a: string;
  b: string;
}

export interface BrainGraph {
  nodes: BrainNode[];
  edges: BrainEdge[];
  idx: Record<string, BrainNode>;
  adj: Record<string, string[]>;
  KIND_LABEL: Record<string, string>;
  activePalette: BrainPalette;
  activePaletteName: string;
  CHAOS: BrainChaos;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ProjectedPoint {
  sx: number;
  sy: number;
  z: number;
  scale: number;
  depth: number;
}

export interface BrainPalette {
  label: string;
  bg: string;
  bgFar: string;
  fg: string;
  hud: string;
  chroma: number;
  kinds: Record<string, string>;
}

export interface BrainChaos {
  wobbleAmp: number;
  wobbleSpeed: number;
  halo: number;
  bloom: number;
  blob: number;
  jitter: number;
}
