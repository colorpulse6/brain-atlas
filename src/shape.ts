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

export function assignLobePositions(nodes: BrainNode[]): void {
  for (const node of nodes) {
    const h = stableHash(node.id);
    const r1 = (h & 0xffff) / 0xffff;
    const r2 = ((h >>> 16) & 0xffff) / 0xffff;
    const r3 = ((Math.imul(h, 31) >>> 0) & 0xffff) / 0xffff;

    const lobe = KIND_TO_LOBE[node.kind] ?? "parietal";
    const center = LOBE_CENTERS[lobe];
    const u = r1 * Math.PI * 2;
    const v = Math.acos(2 * r2 - 1);
    const radius = center.r * (node.hub ? 0.35 : 0.55 + r3 * 0.45);
    const dx = radius * Math.sin(v) * Math.cos(u);
    const dy = radius * Math.sin(v) * Math.sin(u);
    const dz = radius * Math.cos(v);
    let cx = center.c.x;
    if (center.mirror && r1 > 0.5) cx = -cx;

    node._3dLobe = {
      x: cx + dx,
      y: center.c.y + dy,
      z: center.c.z + dz
    };
    node._lobeName = lobe;
  }
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
  LOBE_CENTERS,
  KIND_TO_LOBE
};
