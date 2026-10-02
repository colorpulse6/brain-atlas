import type { BrainNode, LobeName, ProjectedPoint, Vec3 } from "./types.ts";

export interface LobeCenter {
  c: Vec3;
  r: number;
  label: string;
  mirror?: boolean;
}

export const LOBE_CENTERS: Record<LobeName, LobeCenter> = {
  frontal: { c: { x: 0, y: 0.20, z: 0.85 }, r: 0.45, label: "FRONTAL" },
  parietal: { c: { x: 0, y: 0.65, z: -0.10 }, r: 0.40, label: "PARIETAL" },
  temporal: { c: { x: 0.65, y: -0.15, z: 0.10 }, r: 0.32, label: "TEMPORAL", mirror: true },
  occipital: { c: { x: 0, y: 0.05, z: -0.95 }, r: 0.36, label: "OCCIPITAL" },
  cerebellum: { c: { x: 0, y: -0.55, z: -0.78 }, r: 0.32, label: "CEREBELLUM" },
  stem: { c: { x: 0, y: -0.85, z: -0.45 }, r: 0.14, label: "BRAIN STEM" }
};

export const KIND_TO_LOBE: Record<string, LobeName> = {
  decision: "frontal",
  question: "frontal",
  project: "frontal",
  concept: "parietal",
  tool: "parietal",
  workThread: "parietal",
  person: "temporal",
  organization: "temporal",
  source: "occipital",
  repo: "occipital",
  dailyNote: "cerebellum",
  incident: "cerebellum",
  index: "stem"
};

export interface SurfacePoint extends Vec3 {
  theta?: number;
  phi?: number;
  lobe?: LobeName;
  twPhase?: number;
  twFreq?: number;
}

export function brainPoint(theta: number, phi: number, foldAmp = 0.03): Vec3 {
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const cosTh = Math.cos(theta);
  const sinTh = Math.sin(theta);

  let x = 0.95 * cosPhi * sinTh;
  let z = 1.25 * cosPhi * cosTh;
  let y = 0.92 * sinPhi;

  if (z < -0.4) z -= 0.06 * (-z - 0.4);
  if (z > 0.4 && y > -0.1) x *= 1 + 0.05 * Math.min(0.6, z * (y + 0.4));
  if (y < -0.4) y = -0.4 + (y + 0.4) * 0.55;
  if (y > 0.55 && Math.abs(x) < 0.12) y -= 0.04 * (y - 0.55) * (1 - Math.abs(x) / 0.12);

  const fold = foldAmp * (
    Math.sin(theta * 11 + phi * 7)
    + 0.55 * Math.sin(theta * 17 - phi * 5)
    + 0.35 * Math.sin(theta * 5 + phi * 13)
  );
  const r = Math.sqrt(x * x + y * y + z * z) || 1;
  x += (x / r) * fold;
  y += (y / r) * fold;
  z += (z / r) * fold;

  return { x, y, z };
}

export function cerebellumPoint(theta: number, phi: number): Vec3 {
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const ridge = 0.02 * Math.sin(theta * 14 + phi * 9);
  return {
    x: (0.40 + ridge) * cosPhi * Math.sin(theta),
    y: -0.55 + 0.26 * sinPhi,
    z: -0.78 + (0.32 + ridge) * cosPhi * Math.cos(theta)
  };
}

export function stemPoint(t: number, jitter: number): Vec3 {
  return {
    x: jitter * 0.06,
    y: -0.55 - t * 0.45,
    z: -0.55 + jitter * 0.04
  };
}

export function generateSurface(count: number, foldAmp = 0.03): SurfacePoint[] {
  const out: SurfacePoint[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let index = 0; index < count; index += 1) {
    const t = (index + 0.5) / count;
    const phi = Math.asin(2 * t - 1);
    const theta = (golden * index) % (Math.PI * 2);
    out.push({ ...brainPoint(theta, phi, foldAmp), theta, phi });
  }
  return out;
}

export function lobeFor(point: Vec3): LobeName {
  const { x, y, z } = point;
  if (y < -0.30 && z < -0.45) return "cerebellum";
  if (y < -0.50 && Math.abs(z) < 0.45 && Math.abs(x) < 0.25) return "stem";
  if (z > 0.30) return "frontal";
  if (z < -0.55) return "occipital";
  if (y < -0.05 && Math.abs(x) > 0.30) return "temporal";
  if (y > 0.20) return "parietal";
  return "temporal";
}

export function makeProjector(options: {
  rotX: number;
  rotY: number;
  scale: number;
  cx: number;
  cy: number;
  dist?: number;
}): (point: Vec3) => ProjectedPoint {
  const dist = options.dist ?? 3.5;
  const cosY = Math.cos(options.rotY);
  const sinY = Math.sin(options.rotY);
  const cosX = Math.cos(options.rotX);
  const sinX = Math.sin(options.rotX);

  return (point: Vec3) => {
    const rotatedX = point.x * cosY + point.z * sinY;
    const z1 = -point.x * sinY + point.z * cosY;
    const rotatedY = point.y * cosX - z1 * sinX;
    const z2 = point.y * sinX + z1 * cosX;
    const f = options.scale / (dist + z2);
    return {
      sx: options.cx + rotatedX * f * dist,
      sy: options.cy - rotatedY * f * dist,
      z: z2,
      scale: f * dist / options.scale,
      depth: (z2 + 1.5) / 3
    };
  };
}

/**
 * Place every node inside its lobe. `spread` (clustered < 1 < spread) fans notes out WITHIN their own region.
 * spread = 1 (the default) is the original layout, unchanged. Above 1, two things keep the spread even and
 * "relative to the section":
 *   - the per-node scatter scales by `spread` and blends in the region's population (cube root, for constant
 *     density), so a 400-note region opens up proportionally more than a 5-note one instead of staying a tight ball;
 *   - the folder-cluster offset barely moves with `spread`, so clusters stay inside their lobe rather than
 *     flinging outward (which read as "spreading toward the camera" once perspective magnified the near ones).
 */
export function assignLobePositions(nodes: BrainNode[], spread = 1): void {
  const s = Math.max(0.5, Math.min(2.5, spread));
  // Per-lobe population, so denser sections spread proportionally.
  const counts: Record<string, number> = {};
  for (const node of nodes) {
    const lobe = node._lobeName ?? KIND_TO_LOBE[node.kind] ?? "parietal";
    counts[lobe] = (counts[lobe] ?? 0) + 1;
  }
  const clusterScale = 1 + (s - 1) * 0.35; // clusters stay in-section; spacing mostly opens up the scatter
  const densityMix = Math.max(0, Math.min(1, (s - 1) / 0.5)); // 0 at spread <= 1, full by spread 1.5
  for (const node of nodes) {
    const h = stableHash(node.id);
    const r1 = (h & 0xffff) / 0xffff;
    const r2 = ((h >>> 16) & 0xffff) / 0xffff;
    const r3 = ((Math.imul(h, 31) >>> 0) & 0xffff) / 0xffff;

    const lobe = node._lobeName ?? KIND_TO_LOBE[node.kind] ?? "parietal";
    const center = LOBE_CENTERS[lobe];
    const cluster = clusterPoint(node, lobe, center.r);
    const density = Math.max(0.7, Math.min(1.9, Math.cbrt((counts[lobe] ?? 1) / 36)));
    const u = r1 * Math.PI * 2;
    const v = Math.acos(2 * r2 - 1);
    const radius = center.r * (node.hub ? 0.08 : 0.08 + r3 * 0.13) * s * (1 + (density - 1) * densityMix);
    const dx = radius * Math.sin(v) * Math.cos(u);
    const dy = radius * Math.sin(v) * Math.sin(u);
    const dz = radius * Math.cos(v);
    let cx = center.c.x;
    if (center.mirror && r1 > 0.5) cx = -cx;

    node._3dLobe = {
      x: cx + cluster.x * clusterScale + dx,
      y: center.c.y + cluster.y * clusterScale + dy,
      z: center.c.z + cluster.z * clusterScale + dz
    };
    node._lobeName = lobe;
  }
}

/**
 * A deterministic 3D position for a transient live node in `region`. `side` picks a hemisphere for a
 * mirrored region (temporal): "right" (+x) for live/background tasks, "left" (-x) for deployed workflow
 * agents, "auto" hashes. Floated a little outside the note cluster so it reads as "hovering in" the region.
 */
export function liveNodePosition(id: string, region: string, side: "left" | "right" | "auto" = "auto"): Vec3 {
  const lobe = (LOBE_CENTERS[region as LobeName] ? region : "temporal") as LobeName;
  const center = LOBE_CENTERS[lobe];
  const h = stableHash("live:" + id);
  const r1 = (h & 0xffff) / 0xffff;
  const r2 = ((h >>> 16) & 0xffff) / 0xffff;
  const u = r1 * Math.PI * 2;
  const v = Math.acos(2 * r2 - 1);
  const radius = center.r * 1.15;
  let cx = center.c.x;
  if (center.mirror) {
    const mag = Math.abs(center.c.x);
    if (side === "left") cx = -mag;
    else if (side === "right") cx = mag;
    else cx = r1 > 0.5 ? -mag : mag;
  }
  return {
    x: cx + radius * Math.sin(v) * Math.cos(u),
    y: center.c.y + radius * Math.sin(v) * Math.sin(u),
    z: center.c.z + radius * Math.cos(v)
  };
}

/** The temporal outer face where live nodes float: x is fixed per side; nodes spread over the (y, z) plane. */
export const LIVE_FACE = {
  xOffset: 0.34,   // how far outside the temporal lobe the face sits
  seedY: 0.35,     // the first task lands this far above the lobe centre (top of the region), the rest fan out
  boundsY: [-0.85, 0.75] as const,  // face extent relative to the lobe centre (widened if it ever fills)
  boundsZ: [-1.05, 1.05] as const,
  step: 0.11       // candidate-lattice pitch: finer than a label, so "nearest free spot" really is nearby
};

// Where a spot is judged: ON SCREEN. Labels are drawn in screen pixels (10px JetBrains Mono, 4px pad, a 13px box
// radius+4 below the dot), so two nodes that are far apart on the face plane can still collide once the camera
// foreshortens the face (at the reset framing the face's z axis shows at ~half size). Placement therefore projects
// every candidate with the renderer's RESET framing (rotX -0.15, rotY 0.55, dist 3.4) at a deliberately small pane
// (200 px/unit = a ~625px pane at zoom 1) and with a second, flatter framing (rotY 0.3, the brain turned toward
// the front), and accepts a spot only when its drawn box is clear of every occupant's box in both. The camera is
// canonical, not live, so placement stays deterministic: pinned spots never move because the
// user rotated or resized the view.
export const LIVE_CANON = { rotX: -0.15, rotYs: [0.55, 0.3] as const, dist: 3.4, scale: 200 };
const LABEL_CHAR_PX = 6.2;      // 10px JetBrains Mono advance per character
const LABEL_PAD_PX = 4;         // the box is labelWidth + 8
const LABEL_H_PX = 13;          // box height, drawn at sy + radius + 4
const LABEL_GAP_PX = 6;         // breathing room between two boxes
const LIVE_DOT_PX = 2.6 * 1.6;  // nodeRadius of a degree-0 node, allowing a larger node-size setting
const Z_WEIGHT = 2;             // rank candidates so a column (y) fills before stepping sideways (z): y survives
                                // every yaw rotation of the brain, z is foreshortened or collapses entirely

export interface LiveOccupant { label: string; x?: number; y: number; z: number; }
export interface LiveRect { x0: number; y0: number; x1: number; y1: number; }

type Project = (p: Vec3) => ProjectedPoint;
let canonProjectors: Project[] | null = null;
function liveCanonProjectors(): Project[] {
  if (!canonProjectors) {
    canonProjectors = LIVE_CANON.rotYs.map((rotY) =>
      makeProjector({ rotX: LIVE_CANON.rotX, rotY, scale: LIVE_CANON.scale, cx: 0, cy: 0, dist: LIVE_CANON.dist }));
  }
  return canonProjectors;
}

/** The screen box a live node + its label cover under `project` (same geometry as overlay-labels draws). */
export function liveLabelRect(label: string, pos: Vec3, project: Project): LiveRect {
  const q = project(pos);
  const halfW = (Math.max(3, (label || "").length) * LABEL_CHAR_PX) / 2 + LABEL_PAD_PX;
  const radius = LIVE_DOT_PX * Math.max(0.6, q.scale);
  return { x0: q.sx - halfW, y0: q.sy - radius, x1: q.sx + halfW, y1: q.sy + radius + 4 + LABEL_H_PX };
}

/** True when two drawn boxes touch (with a small breathing gap). */
export function liveRectsCollide(a: LiveRect, b: LiveRect, gap = LABEL_GAP_PX): boolean {
  return a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;
}

function occupantRects(occupants: LiveOccupant[], faceX: number): LiveRect[][] {
  const projs = liveCanonProjectors();
  return occupants.map((o) => projs.map((pr) => liveLabelRect(o.label, { x: o.x ?? faceX, y: o.y, z: o.z }, pr)));
}

function clearOf(label: string, pos: Vec3, taken: LiveRect[][]): boolean {
  const projs = liveCanonProjectors();
  for (let i = 0; i < projs.length; i += 1) {
    const me = liveLabelRect(label, pos, projs[i]);
    for (const t of taken) if (liveRectsCollide(me, t[i])) return false;
  }
  return true;
}

/** True when a node at `pos` with this label reads clear of every occupant on screen (canonical framings). */
export function liveSpotClear(label: string, pos: Vec3, occupants: LiveOccupant[]): boolean {
  return clearOf(label, pos, occupantRects(occupants, pos.x));
}

/**
 * Where a NEW live node goes on a temporal side so that its label overlaps nobody ON SCREEN: start at the
 * region's seed (top-centre) and walk a lattice of candidate spots outward -- down the column first, then
 * sideways -- returning the first one whose drawn box is clear of every occupant's box under the canonical
 * framings ("if it would overlap, find a spot nearby that won't"). Occupants are the other live nodes on that
 * side (their pinned positions + labels); a task that ends and fades out leaves the set, so its spot is free for
 * the next task. Deterministic for a given (label, occupants); if the region is genuinely full the bounds widen
 * until a spot exists.
 */
export function placeLiveNode(side: "left" | "right", label: string, occupants: LiveOccupant[]): Vec3 {
  const c = LOBE_CENTERS.temporal.c;
  const x = (side === "left" ? -1 : 1) * (Math.abs(c.x) + LIVE_FACE.xOffset);
  const seedY = c.y + LIVE_FACE.seedY;
  const seedZ = c.z;
  const taken = occupantRects(occupants, x);
  for (let grow = 1; grow <= 4; grow += 1) {
    const yLo = c.y + LIVE_FACE.boundsY[0] * grow;
    const yHi = c.y + LIVE_FACE.boundsY[1] * (grow === 1 ? 1 : 1 + (grow - 1) * 0.5);
    const zLo = c.z + LIVE_FACE.boundsZ[0] * grow;
    const zHi = c.z + LIVE_FACE.boundsZ[1] * grow;
    const cands: Array<{ y: number; z: number; d: number }> = [];
    for (let y = yHi; y >= yLo - 1e-9; y -= LIVE_FACE.step) {
      for (let z = zLo; z <= zHi + 1e-9; z += LIVE_FACE.step) {
        const dy = y - seedY;
        const dz = (z - seedZ) * Z_WEIGHT;
        cands.push({ y, z, d: dy * dy + dz * dz });
      }
    }
    // nearest to the seed first (column-weighted); ties: higher up, then nearer the centre line, then left-to-right
    cands.sort((a, b) => a.d - b.d || b.y - a.y || Math.abs(a.z) - Math.abs(b.z) || a.z - b.z);
    for (const k of cands) {
      if (clearOf(label, { x, y: k.y, z: k.z }, taken)) return { x, y: round4(k.y), z: round4(k.z) };
    }
  }
  // Unreachable in practice (bounds quadrupled); drop below everything rather than overlap.
  const lowest = occupants.reduce((m, o) => Math.min(m, o.y), seedY);
  return { x, y: round4(lowest - 0.3), z: round4(seedZ) };
}

function round4(v: number): number { return Math.round(v * 10000) / 10000; }

function clusterPoint(node: BrainNode, lobe: LobeName, lobeRadius: number): Vec3 {
  const key = `${lobe}:${topFolder(node.path) ?? node.kind}`;
  const h = stableHash(key);
  const r1 = (h & 0xffff) / 0xffff;
  const r2 = ((h >>> 16) & 0xffff) / 0xffff;
  const r3 = ((Math.imul(h, 17) >>> 0) & 0xffff) / 0xffff;
  const u = r1 * Math.PI * 2;
  const v = Math.acos(2 * r2 - 1);
  const radius = lobeRadius * (0.18 + r3 * 0.24);
  return {
    x: radius * Math.sin(v) * Math.cos(u),
    y: radius * Math.sin(v) * Math.sin(u),
    z: radius * Math.cos(v)
  };
}

function topFolder(path: string): string | null {
  const index = path.indexOf("/");
  if (index <= 0) return null;
  return path.slice(0, index).toLowerCase();
}

function stableHash(value: string): number {
  let h = 2166136261 >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export const Brain3D = {
  brainPoint,
  cerebellumPoint,
  stemPoint,
  generateSurface,
  lobeFor,
  makeProjector,
  assignLobePositions,
  liveNodePosition,
  placeLiveNode,
  liveLabelRect,
  liveSpotClear,
  LOBE_CENTERS,
  KIND_TO_LOBE
};
