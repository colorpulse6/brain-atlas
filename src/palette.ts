import type { BrainChaos, BrainPalette, NodeKind } from "./types.ts";

export const PALETTES: Record<string, BrainPalette> = {
  graphite: {
    label: "GRAPHITE",
    bg: "#16151a",
    bgFar: "#0c0b0e",
    fg: "#e8e6e0",
    hud: "#c9b896",
    chroma: 0.4,
    kinds: {
      person: "#d4d0c4",
      project: "#c9b896",
      concept: "#a8b3a0",
      decision: "#d4b878",
      question: "#c89878",
      tool: "#9aa4ac",
      workThread: "#b89898",
      dailyNote: "#c9b896",
      source: "#a8b0bc",
      repo: "#a89cb0",
      incident: "#c47878",
      organization: "#c0b888",
      index: "#bcc4cc",
      unknown: "#8e8a82"
    }
  },
  ink: {
    label: "INK & PAPER",
    bg: "#0a0a0c",
    bgFar: "#040405",
    fg: "#d8d4cc",
    hud: "#b8a888",
    chroma: 0.3,
    kinds: {
      person: "#c8c4bc",
      project: "#b8a888",
      concept: "#9cb0a4",
      decision: "#c4a878",
      question: "#b89878",
      tool: "#909aa4",
      workThread: "#a89090",
      dailyNote: "#c4a878",
      source: "#98a4b4",
      repo: "#9890a8",
      incident: "#b06868",
      organization: "#b8b080",
      index: "#b0b8c0",
      unknown: "#7a7670"
    }
  },
  magma: {
    label: "MAGMA",
    bg: "#0a0306",
    bgFar: "#000000",
    fg: "#ffe9d8",
    hud: "#ffc15e",
    chroma: 1,
    kinds: {
      person: "#ff6b9d",
      project: "#ff8a3d",
      concept: "#ffd93d",
      decision: "#ff3c6f",
      question: "#9d3cff",
      tool: "#ff6b35",
      workThread: "#ff2e93",
      dailyNote: "#ffc15e",
      source: "#c47bff",
      repo: "#7c2ddb",
      incident: "#ff1744",
      organization: "#ffeb3b",
      index: "#ffdf80",
      unknown: "#c4a07a"
    }
  },
  bio: {
    label: "BIOLUMINESCENT",
    bg: "#001318",
    bgFar: "#00060a",
    fg: "#caf0f8",
    hud: "#00f5d4",
    chroma: 1,
    kinds: {
      person: "#00f5d4",
      project: "#ff006e",
      concept: "#aaff00",
      decision: "#ffbe0b",
      question: "#ff5400",
      tool: "#8338ec",
      workThread: "#fb5607",
      dailyNote: "#06ffa5",
      source: "#3a86ff",
      repo: "#7209b7",
      incident: "#ff006e",
      organization: "#ffbe0b",
      index: "#caf0f8",
      unknown: "#8da9b0"
    }
  },
  acid: {
    label: "ACID HOUSE",
    bg: "#06000a",
    bgFar: "#000000",
    fg: "#f0ffd0",
    hud: "#bfff00",
    chroma: 1.15,
    kinds: {
      person: "#ff1cb0",
      project: "#bfff00",
      concept: "#00fff0",
      decision: "#ffe800",
      question: "#ff5c00",
      tool: "#c800ff",
      workThread: "#ff007a",
      dailyNote: "#bfff00",
      source: "#00b6ff",
      repo: "#7a00ff",
      incident: "#ff003c",
      organization: "#fff200",
      index: "#ccff80",
      unknown: "#9a9aa0"
    }
  },
  aurora: {
    label: "AURORA",
    bg: "#03040a",
    bgFar: "#000000",
    fg: "#e6efff",
    hud: "#7cf0ff",
    chroma: 0.85,
    kinds: {
      person: "#7cf0ff",
      project: "#a07bff",
      concept: "#7affc1",
      decision: "#ffd23d",
      question: "#ff8a3d",
      tool: "#62a0d0",
      workThread: "#ff7bdc",
      dailyNote: "#ffb27a",
      source: "#9bd2ff",
      repo: "#b07cff",
      incident: "#ff5d8f",
      organization: "#f0ff7a",
      index: "#cfe9ff",
      unknown: "#9aa9bd"
    }
  },
  daylight: {
    label: "DAYLIGHT",
    bg: "#f7f4ec",
    bgFar: "#e7dfd2",
    fg: "#22303a",
    hud: "#536a7a",
    chroma: 0.5,
    kinds: {
      person: "#385b6f",
      project: "#8a5f18",
      concept: "#52704f",
      decision: "#9a6a22",
      question: "#a14f42",
      tool: "#536979",
      workThread: "#7c5c76",
      dailyNote: "#9a6a22",
      source: "#456c9a",
      repo: "#6c5f8f",
      incident: "#a44242",
      organization: "#6f7435",
      index: "#4f6670",
      unknown: "#7a746c"
    }
  }
};

export const CHAOS: BrainChaos = {
  wobbleAmp: 0.018,
  wobbleSpeed: 0.6,
  halo: 0.6,
  bloom: 0.5,
  blob: 0,
  jitter: 1
};

export const KIND_LABEL: Record<NodeKind, string> = {
  person: "PERSON",
  project: "PROJECT",
  concept: "CONCEPT",
  decision: "DECISION",
  question: "QUESTION",
  tool: "TOOL",
  workThread: "THREAD",
  dailyNote: "DAILY",
  source: "SOURCE",
  repo: "REPO",
  incident: "INCIDENT",
  organization: "ORG",
  index: "INDEX",
  unknown: "UNKNOWN"
};

export const KIND_COLOR: Record<NodeKind, string> = {
  ...(PALETTES.graphite.kinds as Record<NodeKind, string>)
};
