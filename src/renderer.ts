import { Brain3D, LOBE_CENTERS } from "./shape.ts";
import { lobeVisibilityMultiplier } from "./lobe-visibility.ts";
import { displayNodeName } from "./node-display.ts";
import type { BrainGraph, BrainNode, LobeName, ProjectedPoint, Vec3 } from "./types.ts";
import type { SurfacePoint } from "./shape.ts";
import { RenderCore, type ProjectedNode, type ProjectedEdge } from "./render-core.ts";

export type { BrainRendererOptions } from "./render-core.ts";

export class BrainRenderer extends RenderCore {
  private cloud: SurfacePoint[];
  protected ctx: CanvasRenderingContext2D | null = null;

  constructor() {
    super();
    this.cloud = this.buildCloud();
  }

  protected acquireSurface(canvas: HTMLCanvasElement): boolean {
    this.ctx = canvas.getContext("2d");
    return !!this.ctx;
  }

  protected isReady(): boolean {
    return !!this.ctx;
  }

  protected resizeSurface(): void {
    if (!this.canvas || !this.ctx) return;
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  protected releaseSurface(): void {
    this.ctx = null;
  }

  protected drawScene(now: number): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    const graph = this.getGraph?.();
    if (!canvas || !ctx || !graph) return;

    const pal = graph.activePalette;
    const scale = Math.min(this.width, this.height) * 0.32 * this.zoom;
    const cx = this.width / 2;
    const cy = this.height / 2 - this.height * 0.04;
    const project = Brain3D.makeProjector({ rotX: this.rot.x, rotY: this.rot.y, scale, cx, cy, dist: 3.4 });
    const lobeStats = this.getLobeStats();
    const interLobeEdges = graph.edges.filter((edge) => {
      const a = graph.idx[edge.a];
      const b = graph.idx[edge.b];
      return a && b && a._lobeName !== b._lobeName;
    });
    const lobeMul = (lobe?: LobeName) => lobeVisibilityMultiplier(lobe, this.options.enabledLobes, this.highlightLobe);

    // Signal spawning is state mutation (shared across passes), not a draw pass;
    // keep it unconditional so the "signals" pass stays deterministic when gated.
    this.spawnSignals(now, graph, interLobeEdges);

    // Pass: background (radial gradient fill).
    if (this.passEnabled("background")) {
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(this.width, this.height) * 0.75);
      bg.addColorStop(0, pal.bg);
      bg.addColorStop(0.55, pal.bg);
      bg.addColorStop(1, pal.bgFar);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    // Pass: haze (lobe glow gradients, additive).
    if (this.passEnabled("haze")) this.drawLobeHaze(ctx, project, scale, graph, lobeMul);

    const cloudProj = this.cloud.map((p) => ({
      p,
      pr: project(p),
      tw: 0.65 + 0.35 * Math.sin(now * 0.0005 * (p.twFreq ?? 1) + (p.twPhase ?? 0))
    }));
    const nodeProjs = graph.nodes
      .filter((node) => node._3dLobe)
      .map((node) => ({ node, ...project(node._3dLobe as Vec3) }));
    const edgeProjs = this.projectEdges(graph, project);

    // Pass: cloud (far half, z > 0), additive.
    if (this.passEnabled("cloud")) {
      ctx.globalCompositeOperation = "lighter";
      for (const cp of cloudProj) {
        if (cp.pr.z <= 0) continue;
        this.drawCloudPoint(ctx, cp, true, graph, lobeMul);
      }
      ctx.globalCompositeOperation = "source-over";
    }

    // Pass: edges (far half, z > 0).
    if (this.passEnabled("edges")) {
      for (const edge of edgeProjs.filter((e) => e.z > 0).sort((a, b) => b.z - a.z)) {
        this.drawEdge(ctx, edge, true, graph, lobeMul);
      }
    }
    // Pass: nodes (far half, z > 0).
    if (this.passEnabled("nodes")) {
      for (const node of nodeProjs.filter((n) => n.z > 0).sort((a, b) => b.z - a.z)) {
        this.drawNode(ctx, node, graph, lobeMul);
      }
    }

    // Pass: cloud (near half, z <= 0), additive.
    if (this.passEnabled("cloud")) {
      ctx.globalCompositeOperation = "lighter";
      for (const cp of cloudProj) {
        if (cp.pr.z > 0) continue;
        this.drawCloudPoint(ctx, cp, false, graph, lobeMul);
      }
      ctx.globalCompositeOperation = "source-over";
    }

    // Pass: edges (near half, z <= 0).
    if (this.passEnabled("edges")) {
      for (const edge of edgeProjs.filter((e) => e.z <= 0).sort((a, b) => b.z - a.z)) {
        this.drawEdge(ctx, edge, false, graph, lobeMul);
      }
    }
    // Pass: nodes (near half, z <= 0).
    if (this.passEnabled("nodes")) {
      for (const node of nodeProjs.filter((n) => n.z <= 0).sort((a, b) => b.z - a.z)) {
        this.drawNode(ctx, node, graph, lobeMul);
      }
    }

    // Pass: signals (additive particle trails).
    if (this.passEnabled("signals")) this.drawSignals(ctx, now, project, lobeMul);

    // Pass: labels (lobe labels + node labels).
    if (this.passEnabled("labels")) {
      if (this.options.showLobeLabels) this.drawLobeLabels(ctx, project, graph, lobeStats, lobeMul);
      if (this.options.showLobeLabels) this.drawNodeLabels(ctx, nodeProjs, graph, lobeMul);
    }

    // Pass: compass (orientation gizmo).
    if (this.passEnabled("compass")) this.drawCompass(ctx, graph);
  }

  private drawLobeHaze(
    ctx: CanvasRenderingContext2D,
    project: (point: Vec3) => ProjectedPoint,
    scale: number,
    graph: BrainGraph,
    lobeMul: (lobe?: LobeName) => number
  ): void {
    const visuals: Array<{ lobe: LobeName; center: Vec3; lobeCenter: (typeof LOBE_CENTERS)[LobeName]; pr: ProjectedPoint }> = [];
    for (const rawLobe in LOBE_CENTERS) {
      const lobe = rawLobe as LobeName;
      const lobeCenter = LOBE_CENTERS[lobe];
      visuals.push({ lobe, lobeCenter, center: lobeCenter.c, pr: project(lobeCenter.c) });
      if (lobeCenter.mirror) {
        const mirror = { x: -lobeCenter.c.x, y: lobeCenter.c.y, z: lobeCenter.c.z };
        visuals.push({ lobe, lobeCenter, center: mirror, pr: project(mirror) });
      }
    }

    ctx.globalCompositeOperation = "lighter";
    for (const item of visuals.sort((a, b) => b.pr.z - a.pr.z)) {
      const color = this.lobeColor(item.lobe, graph);
      const radius = item.lobeCenter.r * scale * 1.4 * item.pr.scale;
      const depthFade = Math.max(0.25, 1 - item.pr.depth * 0.55);
      const baseA = (this.highlightLobe === item.lobe ? 0.18 : 0.07) * depthFade * lobeMul(item.lobe);
      if (baseA < 0.005) continue;
      const grad = ctx.createRadialGradient(item.pr.sx, item.pr.sy, 0, item.pr.sx, item.pr.sy, radius);
      grad.addColorStop(0, hexA(color, baseA));
      grad.addColorStop(0.55, hexA(color, baseA * 0.45));
      grad.addColorStop(1, hexA(color, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(item.pr.sx, item.pr.sy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  private drawCloudPoint(
    ctx: CanvasRenderingContext2D,
    cp: { p: SurfacePoint; pr: ProjectedPoint; tw: number },
    far: boolean,
    graph: BrainGraph,
    lobeMul: (lobe?: LobeName) => number
  ): void {
    const lobe = cp.p.lobe ?? "parietal";
    const alphaBase = far ? 0.20 : 0.38;
    const alpha = (1 - cp.pr.depth) * alphaBase * cp.tw * lobeMul(lobe);
    ctx.fillStyle = hexA(this.lobeColor(lobe, graph), alpha);
    ctx.beginPath();
    ctx.arc(cp.pr.sx, cp.pr.sy, far ? 0.95 : 1.2, 0, Math.PI * 2);
    ctx.fill();
  }

  private projectEdges(graph: BrainGraph, project: (point: Vec3) => ProjectedPoint): ProjectedEdge[] {
    const samples = 12;
    const edges: ProjectedEdge[] = [];
    for (const edge of graph.edges) {
      const A = graph.idx[edge.a];
      const B = graph.idx[edge.b];
      if (!A?._3dLobe || !B?._3dLobe) continue;
      const ctrl = {
        x: (A._3dLobe.x + B._3dLobe.x) * 0.35,
        y: (A._3dLobe.y + B._3dLobe.y) * 0.35,
        z: (A._3dLobe.z + B._3dLobe.z) * 0.35
      };
      const pts: ProjectedPoint[] = [];
      let zSum = 0;
      for (let index = 0; index <= samples; index += 1) {
        const t = index / samples;
        const mt = 1 - t;
        const point = {
          x: mt * mt * A._3dLobe.x + 2 * mt * t * ctrl.x + t * t * B._3dLobe.x,
          y: mt * mt * A._3dLobe.y + 2 * mt * t * ctrl.y + t * t * B._3dLobe.y,
          z: mt * mt * A._3dLobe.z + 2 * mt * t * ctrl.z + t * t * B._3dLobe.z
        };
        const projected = project(point);
        pts.push(projected);
        zSum += projected.z;
      }
      edges.push({ e: edge, A, B, pts, z: zSum / pts.length, sameLobe: A._lobeName === B._lobeName });
    }
    return edges;
  }

  private drawEdge(
    ctx: CanvasRenderingContext2D,
    edge: ProjectedEdge,
    isFar: boolean,
    graph: BrainGraph,
    lobeMul: (lobe?: LobeName) => number
  ): void {
    const isFocus = this.focusId && (edge.e.a === this.focusId || edge.e.b === this.focusId);
    const isHover = this.hoverId && (edge.e.a === this.hoverId || edge.e.b === this.hoverId);
    const cA = this.lobeColor(edge.A._lobeName ?? "parietal", graph);
    const cB = this.lobeColor(edge.B._lobeName ?? "parietal", graph);
    const lobeM = Math.max(lobeMul(edge.A._lobeName), lobeMul(edge.B._lobeName));
    const interBoost = edge.sameLobe ? 1 : 1.6;
    const baseA = (isFocus ? (isFar ? 0.55 : 0.85)
      : isHover ? (isFar ? 0.25 : 0.40)
        : (isFar ? 0.05 : 0.13)) * lobeM * interBoost;
    ctx.lineWidth = isFocus ? 1.3 : (isFar ? 0.55 : 0.7);
    for (let index = 0; index < edge.pts.length - 1; index += 1) {
      const p0 = edge.pts[index];
      const p1 = edge.pts[index + 1];
      const t = index / (edge.pts.length - 1);
      const alpha = baseA * (1 - ((p0.depth + p1.depth) / 2) * 0.35);
      const color = edge.sameLobe ? cA : (t < 0.5 ? cA : cB);
      ctx.strokeStyle = isFocus ? hexA(edge.A.color, alpha) : hexA(color, alpha);
      ctx.beginPath();
      ctx.moveTo(p0.sx, p0.sy);
      ctx.lineTo(p1.sx, p1.sy);
      ctx.stroke();
    }
  }

  private drawNode(
    ctx: CanvasRenderingContext2D,
    projected: ProjectedNode,
    graph: BrainGraph,
    lobeMul: (lobe?: LobeName) => number
  ): void {
    const node = projected.node;
    const isHover = node.id === this.hoverId;
    const isFocus = node.id === this.focusId;
    const radius = nodeRadius(node) * Math.max(0.55, projected.scale) * (isHover ? 1.18 : isFocus ? 1.25 : 1);
    const fade = Math.max(0.32, 1 - projected.depth * 0.75);
    const dim = node.status === "archived" ? 0.30 : node.status === "dormantRelevant" ? 0.55 : 1;
    const alpha = fade * dim * lobeMul(node._lobeName);
    if (alpha < 0.05) return;

    const haloRadius = radius * 3.6 * graph.CHAOS.halo;
    const halo = ctx.createRadialGradient(projected.sx, projected.sy, 0, projected.sx, projected.sy, haloRadius);
    halo.addColorStop(0, hexA(node.color, 0.32 * alpha * graph.CHAOS.bloom));
    halo.addColorStop(1, hexA(node.color, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(projected.sx, projected.sy, haloRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = hexA(node.color, Math.min(1, alpha * 0.93));
    ctx.beginPath();
    ctx.arc(projected.sx, projected.sy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${Math.min(1, alpha)})`;
    ctx.beginPath();
    ctx.arc(projected.sx, projected.sy, Math.max(0.7, radius * 0.42), 0, Math.PI * 2);
    ctx.fill();

    if (node.hub) {
      ctx.strokeStyle = hexA(node.color, Math.min(1, 0.55 * alpha));
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(projected.sx, projected.sy, radius + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = hexA(node.color, Math.min(1, 0.45 * alpha));
      ctx.beginPath();
      ctx.moveTo(projected.sx - radius * 3.2, projected.sy);
      ctx.lineTo(projected.sx + radius * 3.2, projected.sy);
      ctx.moveTo(projected.sx, projected.sy - radius * 3.2);
      ctx.lineTo(projected.sx, projected.sy + radius * 3.2);
      ctx.stroke();
    }
  }

  private drawSignals(
    ctx: CanvasRenderingContext2D,
    now: number,
    project: (point: Vec3) => ProjectedPoint,
    lobeMul: (lobe?: LobeName) => number
  ): void {
    ctx.globalCompositeOperation = "lighter";
    for (const signal of this.signals) {
      if (!signal.a._3dLobe || !signal.b._3dLobe) continue;
      const tNorm = (now - signal.born) / signal.dur;
      if (tNorm < 0 || tNorm > 1) continue;
      const envelope = Math.sin(tNorm * Math.PI);
      const regionAlpha = Math.max(lobeMul(signal.a._lobeName), lobeMul(signal.b._lobeName));
      const ctrl = {
        x: (signal.a._3dLobe.x + signal.b._3dLobe.x) * 0.35,
        y: (signal.a._3dLobe.y + signal.b._3dLobe.y) * 0.35,
        z: (signal.a._3dLobe.z + signal.b._3dLobe.z) * 0.35
      };
      for (let index = 0; index < 6; index += 1) {
        const t = Math.max(0, tNorm - index * 0.035);
        const mt = 1 - t;
        const point = {
          x: mt * mt * signal.a._3dLobe.x + 2 * mt * t * ctrl.x + t * t * signal.b._3dLobe.x,
          y: mt * mt * signal.a._3dLobe.y + 2 * mt * t * ctrl.y + t * t * signal.b._3dLobe.y,
          z: mt * mt * signal.a._3dLobe.z + 2 * mt * t * ctrl.z + t * t * signal.b._3dLobe.z
        };
        const projected = project(point);
        const color = lerpHex(signal.colA, signal.colB, t);
        const fade = (1 - index / 6) * envelope;
        const depth = Math.max(0.3, 1 - projected.depth * 0.6);
        const radius = (1.3 - index * 0.15) * Math.max(0.5, projected.scale);
        const halo = ctx.createRadialGradient(projected.sx, projected.sy, 0, projected.sx, projected.sy, radius * 3.2);
        halo.addColorStop(0, rgbaFromRgb(color, 0.22 * fade * depth * regionAlpha));
        halo.addColorStop(1, rgbaFromRgb(color, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(projected.sx, projected.sy, radius * 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = rgbaFromRgb(color, 0.55 * fade * depth * regionAlpha);
        ctx.beginPath();
        ctx.arc(projected.sx, projected.sy, Math.max(0.6, radius), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalCompositeOperation = "source-over";
  }

  private drawLobeLabels(
    ctx: CanvasRenderingContext2D,
    project: (point: Vec3) => ProjectedPoint,
    graph: BrainGraph,
    stats: Record<LobeName, number>,
    lobeMul: (lobe?: LobeName) => number
  ): void {
    ctx.textBaseline = "middle";
    for (const rawLobe in LOBE_CENTERS) {
      const lobe = rawLobe as LobeName;
      const center = LOBE_CENTERS[lobe];
      const projected = project(center.c);
      if (projected.z > 0.6) continue;
      const color = this.lobeColor(lobe, graph);
      const alpha = (1 - Math.max(0, projected.depth - 0.2)) * lobeMul(lobe);
      if (alpha < 0.15) continue;
      this.drawLobeLabel(ctx, projected, color, alpha, center.label, `${LOBE_DESCRIPTIONS[lobe].role} - ${stats[lobe] ?? 0} nodes`);
      if (center.mirror) {
        const mirror = project({ x: -center.c.x, y: center.c.y, z: center.c.z });
        if (mirror.z < 0.6) this.drawLobeDot(ctx, mirror, color, alpha);
      }
    }
  }

  private drawLobeLabel(
    ctx: CanvasRenderingContext2D,
    projected: ProjectedPoint,
    color: string,
    alpha: number,
    label: string,
    subtitle: string
  ): void {
    this.drawLobeDot(ctx, projected, color, alpha);
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

  private drawLobeDot(ctx: CanvasRenderingContext2D, projected: ProjectedPoint, color: string, alpha: number): void {
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

  private drawNodeLabels(
    ctx: CanvasRenderingContext2D,
    nodeProjs: ProjectedNode[],
    graph: BrainGraph,
    lobeMul: (lobe?: LobeName) => number
  ): void {
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labels = new Set(this.automaticLabelIds(graph, nodeProjs));
    if (this.hoverId) labels.add(this.hoverId);
    if (this.focusId) {
      labels.add(this.focusId);
      const focusNeighborLabelLimit = this.effectivePerformancePreset() === "mobile"
        ? Math.max(3, Math.min(8, Math.round(4 * this.zoom)))
        : Math.max(8, Math.min(30, Math.round(8 * this.zoom)));
      for (const id of (graph.adj[this.focusId] ?? []).slice(0, focusNeighborLabelLimit)) labels.add(id);
    }
    for (const projected of nodeProjs) {
      if (!labels.has(projected.node.id)) continue;
      if (projected.z > 0.25 && !projected.node.hub) continue;
      const radius = nodeRadius(projected.node) * Math.max(0.6, projected.scale);
      const alpha = Math.max(0.2, 1 - projected.depth * 0.7) * lobeMul(projected.node._lobeName);
      if (alpha < 0.1) continue;
      const label = displayNodeName(projected.node);
      const width = ctx.measureText(label).width;
      ctx.fillStyle = `rgba(0,0,0,${0.5 * alpha})`;
      ctx.fillRect(projected.sx - width / 2 - 4, projected.sy + radius + 4, width + 8, 13);
      ctx.fillStyle = projected.node.id === this.focusId ? `rgba(255,255,255,${alpha})` : hexA(projected.node.color, 0.95 * alpha);
      ctx.fillText(label, projected.sx, projected.sy + radius + 5);
    }
  }

  private automaticLabelIds(graph: BrainGraph, nodeProjs: ProjectedNode[]): Set<string> {
    const maxAutomaticLabels = this.maxAutomaticLabels(graph.nodes.length);
    return new Set(
      nodeProjs
        .filter((projected) => projected.node.hub && projected.z <= 0.45)
        .sort((a, b) => b.node.degree - a.node.degree || a.node.id.localeCompare(b.node.id))
        .slice(0, maxAutomaticLabels)
        .map((projected) => projected.node.id)
    );
  }

  private maxAutomaticLabels(totalNodes: number): number {
    if (this.effectivePerformancePreset() === "mobile") {
      const viewportCap = Math.max(2, Math.floor(this.width / 120));
      const densityCap = totalNodes > 500 ? 3 : 6;
      return Math.min(viewportCap, densityCap);
    }
    const viewportCap = Math.max(6, Math.floor(this.width / 80));
    const zoomCap = this.zoom >= 3 ? 34 : this.zoom >= 2 ? 24 : 14;
    const densityCap = totalNodes > 1000 ? 10 : totalNodes > 500 ? 14 : zoomCap;
    return Math.min(viewportCap, zoomCap, densityCap);
  }

  private drawCompass(ctx: CanvasRenderingContext2D, graph: BrainGraph): void {
    const cx = this.width - 50;
    const cy = this.height - 50;
    const radius = 22;
    ctx.strokeStyle = hexA(graph.activePalette.hud, 0.25);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    const project = Brain3D.makeProjector({ rotX: this.rot.x, rotY: this.rot.y, scale: radius * 4.5, cx, cy, dist: 4 });
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

  private buildCloud(): SurfacePoint[] {
    const surface = Brain3D.generateSurface(1400, 0.026).map((p, index) => ({
      ...p,
      lobe: Brain3D.lobeFor(p),
      twPhase: (index * 0.731) % (Math.PI * 2),
      twFreq: 0.4 + (index % 9) / 12
    }));
    const cerebellum: SurfacePoint[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let index = 0; index < 220; index += 1) {
      const t = (index + 0.5) / 220;
      const phi = Math.asin(2 * t - 1);
      const theta = (golden * index) % (Math.PI * 2);
      cerebellum.push({
        ...Brain3D.cerebellumPoint(theta, phi),
        lobe: "cerebellum",
        twPhase: (index * 0.91) % (Math.PI * 2),
        twFreq: 0.5 + (index % 5) / 8
      });
    }
    const stem: SurfacePoint[] = [];
    for (let index = 0; index < 28; index += 1) {
      const t = (index / 28) * 0.6;
      const a = ((index * 1.31) % 1) - 0.5;
      stem.push({ ...Brain3D.stemPoint(t, a), lobe: "stem", twPhase: index * 0.55, twFreq: 0.3 });
    }
    return [...surface, ...cerebellum, ...stem];
  }
}

const LOBE_DESCRIPTIONS: Record<LobeName, { sub: string; role: string }> = {
  frontal: { sub: "Projects - Decisions - Questions", role: "EXECUTIVE" },
  parietal: { sub: "Concepts - Tools - Threads", role: "INTEGRATION" },
  temporal: { sub: "People - Organizations", role: "SOCIAL" },
  occipital: { sub: "Sources - Repos", role: "PERCEPTION" },
  cerebellum: { sub: "Daily notes - Incidents", role: "TEMPORAL MEMORY" },
  stem: { sub: "Index - Routing", role: "ROUTING" }
};

function nodeRadius(node: BrainNode): number {
  if (node.hub) return 6.5;
  return 2.6 + Math.min(3.4, (node.degree || 0) * 0.42);
}

function hexA(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${alpha})`;
}

function lerpHex(a: string, b: string, t: number): string {
  const ha = a.replace("#", "");
  const hb = b.replace("#", "");
  const ar = parseInt(ha.slice(0, 2), 16);
  const ag = parseInt(ha.slice(2, 4), 16);
  const ab = parseInt(ha.slice(4, 6), 16);
  const br = parseInt(hb.slice(0, 2), 16);
  const bg = parseInt(hb.slice(2, 4), 16);
  const bb = parseInt(hb.slice(4, 6), 16);
  return `rgb(${Math.round(ar + (br - ar) * t)},${Math.round(ag + (bg - ag) * t)},${Math.round(ab + (bb - ab) * t)})`;
}

function rgbaFromRgb(rgb: string, alpha: number): string {
  return rgb.replace("rgb(", "rgba(").replace(")", `,${alpha})`);
}
