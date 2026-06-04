/**
 * Shared overlay label / compass drawing functions.
 *
 * These are pure-ish functions that take a 2D context plus the state they
 * need as parameters — no `this`. Both BrainRenderer (Canvas2D) and
 * BrainGLRenderer (overlay canvas) call them verbatim so the label output is
 * byte-identical between the two renderers.
 *
 * All math/constants are lifted directly from the original BrainRenderer
 * private methods:
 *   drawLobeLabels / drawLobeLabel / drawLobeDot
 *   drawNodeLabels / automaticLabelIds / maxAutomaticLabels
 *   drawCompass
 * Do NOT change fonts, alpha formulas, z-culls, offsets or label caps without
 * updating both places and re-running the 24 Canvas2D self-checks.
 */

import { Brain3D, LOBE_CENTERS } from "./shape.ts";
import { displayNodeName } from "./node-display.ts";
import type { BrainGraph, LobeName, ProjectedPoint, Vec3 } from "./types.ts";
import type { ProjectedNode } from "./render-core.ts";

// ---------------------------------------------------------------------------
// Lobe descriptions — relocated here so both renderers share the same data.
// ---------------------------------------------------------------------------

export const LOBE_DESCRIPTIONS: Record<LobeName, { sub: string; role: string }> = {
  frontal: { sub: "Projects - Decisions - Questions", role: "EXECUTIVE" },
  parietal: { sub: "Concepts - Tools - Threads", role: "INTEGRATION" },
  temporal: { sub: "People - Organizations", role: "SOCIAL" },
  occipital: { sub: "Sources - Repos", role: "PERCEPTION" },
  cerebellum: { sub: "Daily notes - Incidents", role: "TEMPORAL MEMORY" },
  stem: { sub: "Index - Routing", role: "ROUTING" }
};

// ---------------------------------------------------------------------------
// Internal hex-alpha helper (same formula as renderer.ts hexA).
// ---------------------------------------------------------------------------

function hexA(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${alpha})`;
}

// ---------------------------------------------------------------------------
// drawLobeDot
// ---------------------------------------------------------------------------

export function drawLobeDot(
  ctx: CanvasRenderingContext2D,
  projected: ProjectedPoint,
  color: string,
  alpha: number
): void {
  ctx.strokeStyle = hexA(color, 0.8 * alpha);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(projected.sx, projected.sy, 4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = hexA(color, 0.4 * alpha);
  ctx.beginPath();
  ctx.arc(projected.sx, projected.sy, 4, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// drawLobeLabel
// ---------------------------------------------------------------------------

export function drawLobeLabel(
  ctx: CanvasRenderingContext2D,
  projected: ProjectedPoint,
  color: string,
  alpha: number,
  label: string,
  subtitle: string
): void {
  drawLobeDot(ctx, projected, color, alpha);
  const leadX = projected.sx + 22;
  const leadY = projected.sy - 22;
  ctx.strokeStyle = hexA(color, 0.8 * alpha);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(projected.sx + 2.8, projected.sy - 2.8);
  ctx.lineTo(leadX - 4, leadY + 6);
  ctx.stroke();
  ctx.font = "600 11px 'JetBrains Mono', monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = hexA(color, alpha);
  ctx.fillText(label, leadX, leadY);
  ctx.font = "9px 'JetBrains Mono', monospace";
  ctx.fillStyle = hexA(color, 0.62 * alpha);
  ctx.fillText(subtitle, leadX, leadY + 12);
}

// ---------------------------------------------------------------------------
// drawLobeLabels
// ---------------------------------------------------------------------------

export function drawLobeLabels(
  ctx: CanvasRenderingContext2D,
  project: (point: Vec3) => ProjectedPoint,
  graph: BrainGraph,
  stats: Record<LobeName, number>,
  lobeMul: (lobe?: LobeName) => number,
  lobeColor: (lobe: LobeName) => string
): void {
  ctx.textBaseline = "middle";
  for (const rawLobe in LOBE_CENTERS) {
    const lobe = rawLobe as LobeName;
    const center = LOBE_CENTERS[lobe];
    const projected = project(center.c);
    if (projected.z > 0.6) continue;
    const color = lobeColor(lobe);
    const alpha = (1 - Math.max(0, projected.depth - 0.2)) * lobeMul(lobe);
    if (alpha < 0.15) continue;
    drawLobeLabel(
      ctx,
      projected,
      color,
      alpha,
      center.label,
      `${LOBE_DESCRIPTIONS[lobe].role} - ${stats[lobe] ?? 0} nodes`
    );
    if (center.mirror) {
      const mirror = project({ x: -center.c.x, y: center.c.y, z: center.c.z });
      if (mirror.z < 0.6) drawLobeDot(ctx, mirror, color, alpha);
    }
  }
}

// ---------------------------------------------------------------------------
// maxAutomaticLabels
// ---------------------------------------------------------------------------

export function maxAutomaticLabels(
  totalNodes: number,
  mobile: boolean,
  width: number,
  zoom: number
): number {
  if (mobile) {
    const viewportCap = Math.max(2, Math.floor(width / 120));
    const densityCap = totalNodes > 500 ? 3 : 6;
    return Math.min(viewportCap, densityCap);
  }
  const viewportCap = Math.max(6, Math.floor(width / 80));
  const zoomCap = zoom >= 3 ? 34 : zoom >= 2 ? 24 : 14;
  const densityCap = totalNodes > 1000 ? 10 : totalNodes > 500 ? 14 : zoomCap;
  return Math.min(viewportCap, zoomCap, densityCap);
}

// ---------------------------------------------------------------------------
// automaticLabelIds
// ---------------------------------------------------------------------------

export function automaticLabelIds(
  graph: BrainGraph,
  nodeProjs: ProjectedNode[],
  mobile: boolean,
  width: number,
  zoom: number
): Set<string> {
  const cap = maxAutomaticLabels(graph.nodes.length, mobile, width, zoom);
  return new Set(
    nodeProjs
      .filter((projected) => projected.node.hub && projected.z <= 0.45)
      .sort((a, b) => b.node.degree - a.node.degree || a.node.id.localeCompare(b.node.id))
      .slice(0, cap)
      .map((projected) => projected.node.id)
  );
}

// ---------------------------------------------------------------------------
// drawNodeLabels
// ---------------------------------------------------------------------------

export interface NodeLabelOptions {
  hoverId: string | null;
  focusId: string | null;
  zoom: number;
  width: number;
  mobile: boolean;
}

export function drawNodeLabels(
  ctx: CanvasRenderingContext2D,
  nodeProjs: ProjectedNode[],
  graph: BrainGraph,
  lobeMul: (lobe?: LobeName) => number,
  opts: NodeLabelOptions
): void {
  const { hoverId, focusId, zoom, width, mobile } = opts;

  ctx.font = "10px 'JetBrains Mono', monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  const labels = new Set(automaticLabelIds(graph, nodeProjs, mobile, width, zoom));

  if (hoverId) labels.add(hoverId);
  if (focusId) {
    labels.add(focusId);
    const focusNeighborLabelLimit = mobile
      ? Math.max(3, Math.min(8, Math.round(4 * zoom)))
      : Math.max(8, Math.min(30, Math.round(8 * zoom)));
    for (const id of (graph.adj[focusId] ?? []).slice(0, focusNeighborLabelLimit)) labels.add(id);
  }

  for (const projected of nodeProjs) {
    if (!labels.has(projected.node.id)) continue;
    if (projected.z > 0.25 && !projected.node.hub) continue;
    const radius = nodeRadius(projected.node) * Math.max(0.6, projected.scale);
    const alpha = Math.max(0.2, 1 - projected.depth * 0.7) * lobeMul(projected.node._lobeName);
    if (alpha < 0.1) continue;
    const label = displayNodeName(projected.node);
    const labelWidth = ctx.measureText(label).width;
    ctx.fillStyle = `rgba(0,0,0,${0.5 * alpha})`;
    ctx.fillRect(projected.sx - labelWidth / 2 - 4, projected.sy + radius + 4, labelWidth + 8, 13);
    ctx.fillStyle =
      projected.node.id === focusId
        ? `rgba(255,255,255,${alpha})`
        : hexA(projected.node.color, 0.95 * alpha);
    ctx.fillText(label, projected.sx, projected.sy + radius + 5);
  }
}

// ---------------------------------------------------------------------------
// drawCompass
// ---------------------------------------------------------------------------

export function drawCompass(
  ctx: CanvasRenderingContext2D,
  rot: { x: number; y: number },
  graph: BrainGraph,
  width: number,
  height: number
): void {
  const cx = width - 50;
  const cy = height - 50;
  const radius = 22;
  ctx.strokeStyle = hexA(graph.activePalette.hud, 0.25);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  const project = Brain3D.makeProjector({
    rotX: rot.x,
    rotY: rot.y,
    scale: radius * 4.5,
    cx,
    cy,
    dist: 4
  });
  const axes = [
    { name: "L", v: { x: 1, y: 0, z: 0 } },
    { name: "S", v: { x: 0, y: 1, z: 0 } },
    { name: "A", v: { x: 0, y: 0, z: 1 } }
  ];
  for (const axis of axes) {
    const projected = project(axis.v);
    const front = 1 - (projected.z + 1.5) / 3;
    ctx.strokeStyle = hexA(graph.activePalette.hud, 0.30 + front * 0.55);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(projected.sx, projected.sy);
    ctx.stroke();
    ctx.fillStyle = hexA(graph.activePalette.hud, 0.5 + front * 0.4);
    ctx.font = "8px 'JetBrains Mono', monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(axis.name, projected.sx + 3, projected.sy);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeRadius(node: { hub?: boolean; degree?: number }): number {
  if (node.hub) return 6.5;
  return 2.6 + Math.min(3.4, (node.degree || 0) * 0.42);
}
