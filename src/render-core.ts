import { assignLobePositions, Brain3D, KIND_TO_LOBE } from "./shape.ts";
import { allLobesEnabled, type LobeVisibility } from "./lobe-visibility.ts";
import { clampPinnedNodePosition, type PerformancePreset, type PinnedNodePosition } from "./settings.ts";
import type { BrainEdge, BrainGraph, BrainNode, LobeName, ProjectedPoint, Vec3 } from "./types.ts";

export interface SignalParticle {
  id: number;
  a: BrainNode;
  b: BrainNode;
  born: number;
  dur: number;
  colA: string;
  colB: string;
}

export interface ProjectedNode extends ProjectedPoint {
  node: BrainNode;
}

export interface ProjectedEdge {
  e: BrainEdge;
  A: BrainNode;
  B: BrainNode;
  pts: ProjectedPoint[];
  z: number;
  sameLobe: boolean;
}

export interface RotateDragState {
  mode: "rotate";
  startX: number;
  startY: number;
  rotX: number;
  rotY: number;
  moved: boolean;
  pointerId: number;
}

export interface NodeDragState {
  mode: "node";
  startX: number;
  startY: number;
  nodeId: string;
  nodeStart: PinnedNodePosition;
  screenScale: number;
  latestPosition?: PinnedNodePosition;
  moved: boolean;
  pointerId: number;
}

export type DragState = RotateDragState | NodeDragState;

export interface BrainRendererOptions {
  idleAutoRotate: boolean;
  showLobeLabels: boolean;
  enabledLobes: LobeVisibility;
  performancePreset: PerformancePreset;
  mobileMode: boolean;
  onChange?: () => void;
  onPinNode?: (node: BrainNode, position: PinnedNodePosition) => void;
}

export const MIN_ZOOM = 0.55;
export const MAX_ZOOM = 6;
export const PERFORMANCE_FRAME_DELAYS: Record<PerformancePreset, number> = {
  smooth: 0,
  balanced: 1000 / 30,
  batterySaver: 1000 / 20,
  mobile: 1000 / 15
};

const LOBE_KIND: Record<LobeName, string> = {
  frontal: "project",
  parietal: "concept",
  temporal: "person",
  occipital: "source",
  cerebellum: "dailyNote",
  stem: "index"
};

export abstract class RenderCore {
  protected canvas: HTMLCanvasElement | null = null;
  protected ctx: CanvasRenderingContext2D | null = null;
  protected getGraph: (() => BrainGraph) | null = null;
  protected options: BrainRendererOptions = {
    idleAutoRotate: true,
    showLobeLabels: true,
    enabledLobes: allLobesEnabled(),
    performancePreset: "smooth",
    mobileMode: false
  };
  protected raf: number | null = null;
  protected frameTimeout: number | null = null;
  protected resizeObserver: ResizeObserver | null = null;
  protected rot = { x: -0.15, y: 0.55 };
  protected zoom = 1;
  protected drag: DragState | null = null;
  protected lastUserAt = 0;
  protected suppressClickUntil = 0;
  protected projCache: Record<string, ProjectedNode> = {};
  protected signals: SignalParticle[] = [];
  protected lastSpawn = 0;
  protected hoverId: string | null = null;
  protected focusId: string | null = null;
  protected highlightLobe: LobeName | null = null;
  protected width = 1;
  protected height = 1;
  protected dpr = 1;
  protected forcedDpr: number | null = null;

  protected deterministic = false;

  setDeterministic(on: boolean): void { this.deterministic = on; }

  setView(view: { rot?: { x: number; y: number }; zoom?: number; dpr?: number }): void {
    if (view.rot) this.rot = { ...view.rot };
    if (typeof view.zoom === "number") this.zoom = view.zoom;
    if (typeof view.dpr === "number") {
      this.forcedDpr = view.dpr;
      this.resize(); // resizes backing store + transform using forcedDpr; guards on canvas/ctx
    }
    this.requestImmediateFrame();
  }

  protected abstract drawScene(now: number): void;

  protected draw = (now: number): void => {
    this.raf = null;
    const canvas = this.canvas;
    const ctx = this.ctx;
    const graph = this.getGraph?.();
    if (!canvas || !ctx || !graph) return;

    this.ensureLobePositions(graph.nodes);
    if (!this.drag && !this.deterministic && this.options.idleAutoRotate && now - this.lastUserAt > 1800) {
      this.rot.y += 0.00065;
    }

    const scale = Math.min(this.width, this.height) * 0.32 * this.zoom;
    const cx = this.width / 2;
    const cy = this.height / 2 - this.height * 0.04;
    const project = Brain3D.makeProjector({ rotX: this.rot.x, rotY: this.rot.y, scale, cx, cy, dist: 3.4 });
    const nodeProjs = graph.nodes
      .filter((node) => node._3dLobe)
      .map((node) => ({ node, ...project(node._3dLobe as Vec3) }));
    this.projCache = Object.fromEntries(nodeProjs.map((node) => [node.node.id, node]));

    this.drawScene(now);

    this.scheduleNextFrame(this.nextFrameDelay(now));
  };

  start(canvas: HTMLCanvasElement, getGraph: () => BrainGraph, options: Partial<BrainRendererOptions> = {}): void {
    this.stop();
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Brain Atlas requires Canvas 2D support.");
    this.canvas = canvas;
    this.ctx = ctx;
    this.getGraph = getGraph;
    this.options = { ...this.options, ...options };
    this.lastUserAt = performance.now();

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.onContextMenu);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.scheduleNextFrame(0);
  }

  stop(): void {
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.raf = null;
    if (this.frameTimeout != null) window.clearTimeout(this.frameTimeout);
    this.frameTimeout = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.canvas) {
      this.canvas.removeEventListener("pointerdown", this.onPointerDown);
      this.canvas.removeEventListener("pointermove", this.onPointerMove);
      this.canvas.removeEventListener("pointerup", this.onPointerUp);
      this.canvas.removeEventListener("pointercancel", this.onPointerUp);
      this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
      this.canvas.removeEventListener("wheel", this.onWheel);
      this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    }
    this.canvas = null;
    this.ctx = null;
    this.getGraph = null;
    this.drag = null;
  }

  setOptions(options: Partial<BrainRendererOptions>): void {
    this.options = { ...this.options, ...options };
    if (this.canvas && this.ctx && ("performancePreset" in options || "mobileMode" in options)) {
      this.resize();
    }
    this.requestImmediateFrame();
  }

  setHighlightLobe(lobe: LobeName | null): void {
    this.highlightLobe = lobe;
    this.requestImmediateFrame();
  }

  getHoveredNode(): BrainNode | null {
    const graph = this.getGraph?.();
    return this.hoverId && graph ? graph.idx[this.hoverId] ?? null : null;
  }

  getFocusedNode(): BrainNode | null {
    const graph = this.getGraph?.();
    return this.focusId && graph ? graph.idx[this.focusId] ?? null : null;
  }

  getLobeStats(): Record<LobeName, number> {
    const stats = this.emptyLobeStats();
    const graph = this.getGraph?.();
    if (!graph) return stats;
    for (const node of graph.nodes) {
      const lobe = node._lobeName ?? KIND_TO_LOBE[node.kind] ?? "parietal";
      stats[lobe] += 1;
    }
    return stats;
  }

  hitTest(x: number, y: number): BrainNode | null {
    return this.hitTestProjected(x, y)?.node ?? null;
  }

  consumeSuppressedClick(): boolean {
    if (!this.suppressClickUntil || performance.now() > this.suppressClickUntil) {
      this.suppressClickUntil = 0;
      return false;
    }
    this.suppressClickUntil = 0;
    return true;
  }

  protected hitTestProjected(x: number, y: number): ProjectedNode | null {
    let best: ProjectedNode | null = null;
    let bestDistance = this.hitTolerance();
    for (const id in this.projCache) {
      const projected = this.projCache[id];
      if (projected.z > 0.4) continue;
      const distance = Math.hypot(x - projected.sx, y - projected.sy);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = projected;
      }
    }
    return best;
  }

  protected nextFrameDelay(now: number): number {
    const preset = this.effectivePerformancePreset();
    if (preset === "smooth") return 0;
    if (this.drag || now - this.lastUserAt < 700) return 0;
    return PERFORMANCE_FRAME_DELAYS[preset] ?? 0;
  }

  protected effectivePerformancePreset(): PerformancePreset {
    if (this.options.mobileMode && this.options.performancePreset === "smooth") return "mobile";
    return this.options.performancePreset;
  }

  protected scheduleNextFrame(delay: number): void {
    if (!this.canvas || this.raf != null || this.frameTimeout != null) return;
    if (delay <= 0) {
      this.raf = requestAnimationFrame(this.draw);
      return;
    }
    this.frameTimeout = window.setTimeout(() => {
      this.frameTimeout = null;
      if (!this.canvas) return;
      this.raf = requestAnimationFrame(this.draw);
    }, delay);
  }

  protected requestImmediateFrame(): void {
    if (!this.canvas) return;
    if (this.frameTimeout != null) {
      window.clearTimeout(this.frameTimeout);
      this.frameTimeout = null;
    }
    if (this.raf == null) this.raf = requestAnimationFrame(this.draw);
  }

  protected onPointerDown = (event: PointerEvent): void => {
    if (!this.canvas || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const point = this.localPoint(event);
    const hit = this.hitTestProjected(point.x, point.y);
    if (hit?.node._3dLobe) {
      const nodeStart = clampPinnedNodePosition(hit.node._3dLobe);
      this.drag = {
        mode: "node",
        startX: event.clientX,
        startY: event.clientY,
        nodeId: hit.node.id,
        nodeStart,
        screenScale: Math.max(80, this.currentProjectionScale() * Math.max(0.4, hit.scale)),
        moved: false,
        pointerId: event.pointerId
      };
      this.focusId = hit.node.id;
      this.hoverId = hit.node.id;
      this.options.onChange?.();
    } else {
      this.drag = {
        mode: "rotate",
        startX: event.clientX,
        startY: event.clientY,
        rotX: this.rot.x,
        rotY: this.rot.y,
        moved: false,
        pointerId: event.pointerId
      };
    }
    this.lastUserAt = performance.now();
    this.canvas.setPointerCapture(event.pointerId);
    this.requestImmediateFrame();
  };

  protected onPointerMove = (event: PointerEvent): void => {
    if (!this.canvas) return;
    event.stopPropagation();
    if (this.drag) {
      event.preventDefault();
      const screenDx = event.clientX - this.drag.startX;
      const screenDy = event.clientY - this.drag.startY;
      this.drag.moved = this.drag.moved || Math.hypot(screenDx, screenDy) > 3;
      if (this.drag.mode === "node") {
        const next = this.draggedNodePosition(this.drag, screenDx, screenDy);
        this.drag.latestPosition = next;
        this.moveNodeTo(this.drag.nodeId, next);
        this.focusId = this.drag.nodeId;
        this.hoverId = this.drag.nodeId;
        this.options.onChange?.();
      } else {
        const dx = screenDx / 180;
        const dy = screenDy / 180;
        this.rot.y = this.drag.rotY + dx;
        this.rot.x = Math.max(-1.4, Math.min(1.4, this.drag.rotX + dy));
      }
      this.lastUserAt = performance.now();
      this.requestImmediateFrame();
      return;
    }

    const point = this.localPoint(event);
    const hit = this.hitTest(point.x, point.y);
    if ((hit?.id ?? null) !== this.hoverId) {
      this.hoverId = hit?.id ?? null;
      this.options.onChange?.();
      this.requestImmediateFrame();
    }
  };

  protected onPointerUp = (event: PointerEvent): void => {
    event.stopPropagation();
    const activeDrag = this.drag;
    this.drag = null;
    if (!activeDrag) return;
    try {
      this.canvas?.releasePointerCapture(activeDrag.pointerId);
    } catch {
      // Obsidian can release capture when panes change during interaction.
    }
    if (activeDrag.mode === "node" && activeDrag.moved && activeDrag.latestPosition) {
      const graph = this.getGraph?.();
      const node = graph?.idx[activeDrag.nodeId];
      if (node) this.options.onPinNode?.(node, activeDrag.latestPosition);
      this.suppressClickUntil = performance.now() + 600;
      this.options.onChange?.();
      this.requestImmediateFrame();
      return;
    }
    if (activeDrag.moved) {
      this.suppressClickUntil = performance.now() + 600;
      return;
    }
    const point = this.localPoint(event);
    const hit = this.hitTest(point.x, point.y);
    this.focusId = hit?.id ?? null;
    this.options.onChange?.();
    this.requestImmediateFrame();
  };

  protected onPointerLeave = (): void => {
    if (this.drag) return;
    if (this.hoverId) {
      this.hoverId = null;
      this.options.onChange?.();
      this.requestImmediateFrame();
    }
  };

  protected onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    this.zoom *= 1 - event.deltaY * 0.0012;
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom));
    this.lastUserAt = performance.now();
    this.requestImmediateFrame();
  };

  protected onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    this.rot = { x: -0.15, y: 0.55 };
    this.zoom = 1;
    this.lastUserAt = performance.now();
    this.requestImmediateFrame();
  };

  protected localPoint(event: MouseEvent | PointerEvent): { x: number; y: number } {
    const rect = this.canvas?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }

  protected draggedNodePosition(drag: NodeDragState, screenDx: number, screenDy: number): PinnedNodePosition {
    const right = this.cameraRight();
    const up = this.cameraUp();
    const dx = screenDx / drag.screenScale;
    const dy = screenDy / drag.screenScale;
    return clampPinnedNodePosition({
      x: drag.nodeStart.x + right.x * dx - up.x * dy,
      y: drag.nodeStart.y + right.y * dx - up.y * dy,
      z: drag.nodeStart.z + right.z * dx - up.z * dy
    });
  }

  protected moveNodeTo(nodeId: string, position: PinnedNodePosition): void {
    const graph = this.getGraph?.();
    const node = graph?.idx[nodeId];
    if (!node) return;
    node._3dLobe = { ...position };
  }

  protected cameraRight(): Vec3 {
    return { x: Math.cos(this.rot.y), y: 0, z: Math.sin(this.rot.y) };
  }

  protected cameraUp(): Vec3 {
    return {
      x: Math.sin(this.rot.y) * Math.sin(this.rot.x),
      y: Math.cos(this.rot.x),
      z: -Math.cos(this.rot.y) * Math.sin(this.rot.x)
    };
  }

  protected currentProjectionScale(): number {
    return Math.min(this.width, this.height) * 0.32 * this.zoom;
  }

  protected hitTolerance(): number {
    return Math.max(7, 18 / Math.sqrt(this.zoom));
  }

  protected resize(): void {
    if (!this.canvas || !this.ctx) return;
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = this.forcedDpr ?? Math.min(this.maxDevicePixelRatio(), window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.requestImmediateFrame();
  }

  protected maxDevicePixelRatio(): number {
    return this.effectivePerformancePreset() === "mobile" ? 1 : 2;
  }

  protected ensureLobePositions(nodes: BrainNode[]): void {
    if (nodes.some((node) => !node._3dLobe)) assignLobePositions(nodes);
  }

  protected emptyLobeStats(): Record<LobeName, number> {
    return { frontal: 0, parietal: 0, temporal: 0, occipital: 0, cerebellum: 0, stem: 0 };
  }

  protected lobeColor(lobe: LobeName, graph: BrainGraph): string {
    return graph.activePalette.kinds[LOBE_KIND[lobe] ?? "concept"] ?? graph.activePalette.hud;
  }

  protected spawnSignals(now: number, graph: BrainGraph, interLobeEdges: BrainEdge[]): void {
    if (this.deterministic) {
      // In deterministic mode, don't spawn new signals; existing ones still animate.
      for (let index = this.signals.length - 1; index >= 0; index -= 1) {
        if (now - this.signals[index].born > this.signals[index].dur) this.signals.splice(index, 1);
      }
      return;
    }
    if (interLobeEdges.length && now - this.lastSpawn > 900) {
      this.lastSpawn = now;
      const edge = interLobeEdges[Math.floor(Math.random() * interLobeEdges.length)];
      const forward = Math.random() < 0.5;
      const A = graph.idx[forward ? edge.a : edge.b];
      const B = graph.idx[forward ? edge.b : edge.a];
      if (A && B) {
        this.signals.push({
          id: Math.random(),
          a: A,
          b: B,
          born: now,
          dur: 2400 + Math.random() * 1100,
          colA: A.color,
          colB: B.color
        });
      }
    }
    for (let index = this.signals.length - 1; index >= 0; index -= 1) {
      if (now - this.signals[index].born > this.signals[index].dur) this.signals.splice(index, 1);
    }
  }
}
