import { assignLobePositions, Brain3D, KIND_TO_LOBE } from "./shape.ts";
import { allLobesEnabled, type LobeVisibility } from "./lobe-visibility.ts";
import { clampPinnedNodePosition, type PerformancePreset, type PinnedNodePosition } from "./settings.ts";
import type { BrainEdge, BrainGraph, BrainNode, LobeName, ProjectedPoint, Vec3 } from "./types.ts";
import type { ActivityState } from "./activity.ts";

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

/** A transient live node projected to screen space, handed to the view to draw as a reticle + task row. */
export interface LiveScreenNode {
  id: string;
  label: string;
  detail: string;
  kind: string;
  region: string;
  color: string;
  seq: number;
  sx: number;
  sy: number;
  depth: number;
  level: number;
  active: boolean;
}

/** Where to anchor the live-node stack (the temporal lobe's projected screen point). */
export interface LiveAnchor {
  sx: number;
  sy: number;
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

export interface PanDragState {
  mode: "pan";
  startX: number;
  startY: number;
  panX: number;
  panY: number;
  moved: boolean;
  pointerId: number;
}

export type DragState = RotateDragState | NodeDragState | PanDragState;

/** Pointer travel, in CSS pixels, that maps to one radian of rotation. */
export const DRAG_PIXELS_PER_RADIAN = 180;

/** Vertical rotation limit, keeping the volume from tumbling past its poles. */
export const MAX_ROT_X = 1.4;

/**
 * Map a canvas drag onto camera rotation.
 *
 * Both deltas are subtracted, not added. The projector's +z runs away from the
 * camera, so adding them rotates the volume as though the pointer had grabbed
 * its FAR surface: the near side then travels against the cursor and the brain
 * reads as inside-out, with no way to tell which nodes are closest. Subtracting
 * puts the near surface under the cursor, matching node dragging (which already
 * follows the pointer) and every other orbit control.
 */
export function rotationFromDrag(
  start: { x: number; y: number },
  screenDx: number,
  screenDy: number
): { x: number; y: number } {
  const dx = screenDx / DRAG_PIXELS_PER_RADIAN;
  const dy = screenDy / DRAG_PIXELS_PER_RADIAN;
  return {
    x: Math.max(-MAX_ROT_X, Math.min(MAX_ROT_X, start.x - dy)),
    y: start.y - dx
  };
}

export interface BrainRendererOptions {
  idleAutoRotate: boolean;
  showLobeLabels: boolean;
  /**
   * Live activity mode (the feature toggle). On = each read/write/spawn fires a signal to the note it
   * touched and glowing notes are labelled. Off = no activity signals or labels.
   */
  liveActivity: boolean;
  /**
   * The cloud twinkle and the ambient signals between regions. Independent of live activity; off
   * freezes the twinkle clock and stops ambient signals, so with live activity on only real reads
   * and writes animate.
   */
  ambientAnimation: boolean;
  /** Multiplies every node's drawn radius (graph-view "node size"). 1 = default. */
  nodeSizeScale: number;
  /** Multiplies the drawn edge/link width (graph-view "link thickness"). 1 = default. */
  linkThickness: number;
  enabledLobes: LobeVisibility;
  performancePreset: PerformancePreset;
  mobileMode: boolean;
  onChange?: () => void;
  onPinNode?: (node: BrainNode, position: PinnedNodePosition) => void;
  /**
   * Called once per frame with the transient live nodes projected to screen space and the temporal-lobe
   * anchor to stack them from (the view renders reticle markers + a task panel). Fires with [] once when the
   * last live node fades, so the view can clear its layer. Both renderers use the same CPU projector, so the
   * markers track the volume in Canvas2D and WebGL alike.
   */
  onLiveNodes?: (nodes: LiveScreenNode[], anchor: LiveAnchor) => void;
  /**
   * Called when the WebGL renderer determines it cannot recover (context
   * permanently lost or resource rebuild failed). The view should fall back
   * to Canvas2D in response.
   */
  onRendererUnavailable?: () => void;
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
  protected getGraph: (() => BrainGraph) | null = null;
  protected options: BrainRendererOptions = {
    idleAutoRotate: true,
    showLobeLabels: true,
    liveActivity: false,
    ambientAnimation: true,
    nodeSizeScale: 1,
    linkThickness: 1,
    enabledLobes: allLobesEnabled(),
    performancePreset: "smooth",
    mobileMode: false
  };
  protected raf: number | null = null;
  protected frameTimeout: number | null = null;
  protected resizeObserver: ResizeObserver | null = null;
  protected rot = { x: -0.15, y: 0.55 };
  protected zoom = 1;
  /** Screen-space pan offset (shift-drag or middle-drag), in CSS pixels. */
  protected panX = 0;
  protected panY = 0;
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

  /**
   * Live activity (nodes lit by external read/write events). Shared by every view;
   * null = feature off. tick() runs once per frame in draw(); while anything glows
   * the frame delay drops to 0 so the fade animates even on throttled presets.
   */
  protected activity: ActivityState | null = null;

  setActivity(state: ActivityState | null): void {
    this.activity = state;
    this.requestImmediateFrame();
  }

  /** Wake the frame loop now (e.g. a live-activity event arrived while idle). No rebuild. */
  requestFrame(): void {
    this.requestImmediateFrame();
  }

  /**
   * Pass-gating test seam. null = render all passes (production default).
   * When a Set is supplied, only passes whose name is present are drawn.
   * Lets the A/B harness compare matching SUBSETS of passes while they are
   * built incrementally (e.g. {"background"} now, {"background","haze"} next).
   */
  protected enabledPasses: Set<string> | null = null;

  setDeterministic(on: boolean): void { this.deterministic = on; }

  /** Test-only: restrict drawScene to a subset of passes (null = all passes). */
  setEnabledPassesForTest(passes: Set<string> | null): void {
    this.enabledPasses = passes;
    this.requestImmediateFrame();
  }

  /** True if the named pass should be drawn under the current gating. */
  protected passEnabled(name: string): boolean {
    return !this.enabledPasses || this.enabledPasses.has(name);
  }

  setView(view: { rot?: { x: number; y: number }; zoom?: number; dpr?: number }): void {
    if (view.rot) this.rot = { ...view.rot };
    if (typeof view.zoom === "number") this.zoom = view.zoom;
    if (typeof view.dpr === "number") {
      this.forcedDpr = view.dpr;
      this.resize(); // resizes backing store + transform using forcedDpr; guards on canvas/isReady
    }
    this.requestImmediateFrame();
  }

  protected abstract drawScene(now: number): void;

  /**
   * Acquire the rendering surface(s) for `canvas`. Subclass responsibility:
   * the Canvas2D renderer grabs a 2D context; the WebGL renderer grabs a
   * WebGL2 context and creates its overlay canvas. Returns false on failure
   * (e.g. no WebGL2 support) — `start()` will then stop and throw.
   */
  protected abstract acquireSurface(canvas: HTMLCanvasElement): boolean;

  /**
   * Size the backing store(s) and set transforms/viewport using the already
   * computed this.width / this.height / this.dpr. Called by base resize().
   */
  protected abstract resizeSurface(): void;

  /** True once the subclass surface is acquired and ready to draw. */
  protected abstract isReady(): boolean;

  /**
   * The element that receives pointer/wheel/contextmenu listeners and that the
   * host view should size. Base attaches listeners to this.canvas; the WebGL
   * renderer's interaction target is the same WebGL canvas.
   */
  getInteractionTarget(): HTMLCanvasElement | null {
    return this.canvas;
  }

  protected draw = (now: number): void => {
    this.raf = null;
    const canvas = this.canvas;
    const graph = this.getGraph?.();
    if (!canvas || !this.isReady() || !graph) return;
    // Hidden tab (no layout box): stop the loop instead of drawing unseen
    // frames. Showing the tab resizes the canvas, and resize() restarts it.
    if (canvas.getClientRects().length === 0) return;

    this.ensureLobePositions(graph.nodes);
    if (!this.drag && !this.deterministic && this.options.idleAutoRotate && now - this.lastUserAt > 1800) {
      this.rot.y += 0.00065;
    }

    const scale = Math.min(this.width, this.height) * 0.32 * this.zoom;
    const { cx, cy } = this.viewCenter();
    const project = Brain3D.makeProjector({ rotX: this.rot.x, rotY: this.rot.y, scale, cx, cy, dist: 3.4 });
    const nodeProjs = graph.nodes
      .filter((node) => node._3dLobe)
      .map((node) => ({ node, ...project(node._3dLobe as Vec3) }));
    this.projCache = Object.fromEntries(nodeProjs.map((node) => [node.node.id, node]));

    this.activity?.tick(now);
    this.drawScene(now);
    this.emitLiveNodes(project);

    this.scheduleNextFrame(this.nextFrameDelay(now));
  };

  /** How many live nodes we last handed the view (so we emit [] exactly once when they all fade). */
  private lastLiveEmitted = 0;

  /** Project the transient live nodes + the temporal anchor and hand them to the view (DOM reticles + panel). */
  protected emitLiveNodes(project: (point: Vec3) => ProjectedPoint): void {
    const cb = this.options.onLiveNodes;
    if (!cb || !this.activity) return;
    const live = this.activity.liveNodes();
    if (live.length === 0 && this.lastLiveEmitted === 0) return;
    this.lastLiveEmitted = live.length;
    const anchorPt = project(Brain3D.LOBE_CENTERS.temporal.c);
    const out: LiveScreenNode[] = live.map((entry) => {
      const projected = project(Brain3D.liveNodePosition(entry.id, entry.region));
      return {
        id: entry.id,
        label: entry.label,
        detail: entry.detail,
        kind: entry.kind,
        region: entry.region,
        color: this.activity!.liveColorFor(entry),
        seq: entry.seq,
        sx: projected.sx,
        sy: projected.sy,
        depth: projected.depth,
        level: entry.level,
        active: entry.active
      };
    });
    cb(out, { sx: anchorPt.sx, sy: anchorPt.sy });
  }

  /** Ids of nodes currently lit by read/write activity ("in use"), for minimal node labels. */
  protected activeNoteIds(): Set<string> {
    const ids = new Set<string>();
    if (this.activity) {
      for (const [id] of this.activity.active()) ids.add(id);
    }
    return ids;
  }

  start(canvas: HTMLCanvasElement, getGraph: () => BrainGraph, options: Partial<BrainRendererOptions> = {}): void {
    this.stop();
    if (!this.acquireSurface(canvas)) {
      throw new Error("Brain Atlas could not acquire a rendering surface.");
    }
    this.canvas = canvas;
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
    if (this.raf != null) window.cancelAnimationFrame(this.raf);
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
    this.releaseSurface();
    this.canvas = null;
    this.getGraph = null;
    this.drag = null;
  }

  /**
   * Release subclass-owned surface resources (contexts, extra canvases, GL
   * objects). Called by stop() before this.canvas is cleared. Default no-op.
   */
  protected releaseSurface(): void {}

  setOptions(options: Partial<BrainRendererOptions>): void {
    this.options = { ...this.options, ...options };
    if (this.canvas && this.isReady() && ("performancePreset" in options || "mobileMode" in options)) {
      this.resize();
    }
    this.requestImmediateFrame();
  }

  setHighlightLobe(lobe: LobeName | null): void {
    this.highlightLobe = lobe;
    this.requestImmediateFrame();
  }

  // ---- Test-only seams (used by A/B pixel-diff harness) ----
  setFocusForTest(id: string | null): void { this.focusId = id; this.requestImmediateFrame(); }
  setHoverForTest(id: string | null): void { this.hoverId = id; this.requestImmediateFrame(); }
  /** Test-only: inject a fixed signal list so the signals pass is deterministic and comparable. */
  setSignalsForTest(signals: SignalParticle[]): void { this.signals = signals; this.requestImmediateFrame(); }
  /**
   * Test-only: drive moveNodeTo (the same path a node drag fires on every
   * pointermove) so the A/B harness can verify the partial buffer update without
   * synthesizing pointer events. Triggers onNodeMoved on the subclass.
   */
  moveNodeForTest(nodeId: string, position: PinnedNodePosition): void {
    this.moveNodeTo(nodeId, position);
    this.requestImmediateFrame();
  }
  renderOnceForTest(now: number): void {
    this.draw(now);
    // draw() schedules a follow-up RAF; cancel it so the harness gets exactly one clean frame.
    if (this.raf != null) { window.cancelAnimationFrame(this.raf); this.raf = null; }
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
    if (this.activity && this.activity.activeCount() > 0) return 0;
    return PERFORMANCE_FRAME_DELAYS[preset] ?? 0;
  }

  protected effectivePerformancePreset(): PerformancePreset {
    if (this.options.mobileMode && this.options.performancePreset === "smooth") return "mobile";
    return this.options.performancePreset;
  }

  protected scheduleNextFrame(delay: number): void {
    if (!this.canvas || this.raf != null || this.frameTimeout != null) return;
    if (delay <= 0) {
      this.raf = window.requestAnimationFrame(this.draw);
      return;
    }
    this.frameTimeout = window.setTimeout(() => {
      this.frameTimeout = null;
      if (!this.canvas) return;
      this.raf = window.requestAnimationFrame(this.draw);
    }, delay);
  }

  protected requestImmediateFrame(): void {
    if (!this.canvas) return;
    if (this.frameTimeout != null) {
      window.clearTimeout(this.frameTimeout);
      this.frameTimeout = null;
    }
    if (this.raf == null) this.raf = window.requestAnimationFrame(this.draw);
  }

  protected onPointerDown = (event: PointerEvent): void => {
    if (!this.canvas) return;
    // Middle button, or Shift/Alt + left = pan (translate the view). Left alone = rotate/drag a node.
    const wantsPan = event.button === 1 || (event.button === 0 && (event.shiftKey || event.altKey));
    if (event.button !== 0 && !wantsPan) return;
    event.preventDefault();
    event.stopPropagation();
    if (wantsPan) {
      this.drag = {
        mode: "pan",
        startX: event.clientX,
        startY: event.clientY,
        panX: this.panX,
        panY: this.panY,
        moved: false,
        pointerId: event.pointerId
      };
      this.lastUserAt = performance.now();
      this.canvas.setPointerCapture(event.pointerId);
      this.requestImmediateFrame();
      return;
    }
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
      if (this.drag.mode === "pan") {
        this.panX = this.drag.panX + screenDx;
        this.panY = this.drag.panY + screenDy;
        this.lastUserAt = performance.now();
        this.requestImmediateFrame();
        return;
      }
      if (this.drag.mode === "node") {
        const next = this.draggedNodePosition(this.drag, screenDx, screenDy);
        this.drag.latestPosition = next;
        this.moveNodeTo(this.drag.nodeId, next);
        this.focusId = this.drag.nodeId;
        this.hoverId = this.drag.nodeId;
        this.options.onChange?.();
      } else {
        const next = rotationFromDrag({ x: this.drag.rotX, y: this.drag.rotY }, screenDx, screenDy);
        this.rot.x = next.x;
        this.rot.y = next.y;
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
    this.resetView();
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
    // Notify the subclass so it can react to the moved node. Canvas2D re-projects
    // from _3dLobe every frame so it leaves this a no-op; the WebGL renderer
    // overrides it to perform a partial buffer update (the dragged node's vertex
    // block + its incident edges' vertex blocks) instead of a full rebuild.
    this.onNodeMoved(nodeId);
  }

  /**
   * Called after a node's _3dLobe is mutated by moveNodeTo (i.e. during a drag).
   * Default no-op: the Canvas2D renderer re-projects from _3dLobe each frame, so
   * the drag is already correct there. The WebGL renderer overrides this to push
   * a partial bufferSubData update (only the moved node + its incident edges).
   */
  protected onNodeMoved(_nodeId: string): void {}

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

  /** The on-screen projection center, including the pan offset. Every projector site uses this. */
  protected viewCenter(): { cx: number; cy: number } {
    return { cx: this.width / 2 + this.panX, cy: this.height / 2 - this.height * 0.04 + this.panY };
  }

  /** Reset rotation, zoom and pan to the default framing (right-click, or the Reset control). */
  resetView(): void {
    this.rot = { x: -0.15, y: 0.55 };
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.lastUserAt = performance.now();
    this.requestImmediateFrame();
  }

  protected hitTolerance(): number {
    return Math.max(7, 18 / Math.sqrt(this.zoom));
  }

  protected resize(): void {
    if (!this.canvas || !this.isReady()) return;
    const rect = this.canvas.getBoundingClientRect();
    // A hidden tab measures 0x0. Keep the last real size; the ResizeObserver
    // fires again with the real size when the tab is shown.
    if (rect.width === 0 || rect.height === 0) return;
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = this.forcedDpr ?? Math.min(this.maxDevicePixelRatio(), window.devicePixelRatio || 1);
    this.resizeSurface();
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

  private signalHub: BrainNode | null = null;
  private signalHubGraph: BrainGraph | null = null;

  /**
   * Ambient animation on: ambient signals travel a random inter-lobe edge every 900 ms.
   * Live activity on: each read/write/spawn recorded by ActivityState also fires one signal from the brain's
   * routing hub to the touched node, so every action visibly does something. With ambient animation off as well,
   * the brain sits still when nothing is happening. Deterministic mode (the A/B harness) never spawns.
   */
  protected spawnSignals(now: number, graph: BrainGraph, interLobeEdges: BrainEdge[]): void {
    if (!this.deterministic && this.options.ambientAnimation && interLobeEdges.length && now - this.lastSpawn > 900) {
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
    if (!this.deterministic && this.options.liveActivity && this.activity) {
      for (const ev of this.activity.drainFires()) {
        const target = graph.idx[ev.target];
        if (!target?._3dLobe) continue;
        const source = this.signalSource(graph, target);
        this.signals.push({
          id: Math.random(),
          a: source,
          b: target,
          born: now,
          dur: ev.kind === "spawn" ? 950 : 650,
          colA: source.color,
          colB: target.color
        });
      }
    }
    for (let index = this.signals.length - 1; index >= 0; index -= 1) {
      if (now - this.signals[index].born > this.signals[index].dur) this.signals.splice(index, 1);
    }
  }

  /** The node a fired signal travels FROM: the highest-degree hub, else a pseudo node at the brain-stem core. */
  protected signalSource(graph: BrainGraph, target: BrainNode): BrainNode {
    if (this.signalHubGraph !== graph) {
      this.signalHubGraph = graph;
      this.signalHub = null;
      let best = -1;
      for (const node of graph.nodes) {
        if (!node._3dLobe) continue;
        if ((node.degree || 0) > best) { best = node.degree || 0; this.signalHub = node; }
      }
    }
    const hub = this.signalHub;
    if (hub && hub._3dLobe && hub.id !== target.id) return hub;
    return {
      id: "__stem__", name: "", title: "", kind: "index", kindLabel: "", status: "active",
      hub: false, degree: 0, color: graph.activePalette.hud, path: "", classificationSource: "default",
      _3dLobe: { ...Brain3D.LOBE_CENTERS.stem.c }, _lobeName: "stem"
    };
  }
}
