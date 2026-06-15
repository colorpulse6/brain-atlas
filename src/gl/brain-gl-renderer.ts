/**
 * WebGL2 brain renderer.
 *
 * Architecture (per the WebGL renderer design spec):
 *   - A WebGL2 canvas (bottom) renders everything that blends against the
 *     background: background gradient, lobe haze, point cloud, edges, node
 *     halos + cores, signals.
 *   - An overlay Canvas2D canvas (top) renders text: lobe labels, node labels,
 *     compass. It exactly overlaps the WebGL canvas and is pointer-transparent.
 *
 * This task (Task 6) implements ONLY the background pass. All other passes are
 * left as clearly marked TODO stubs, each guarded by passEnabled(...) so later
 * tasks (7-11) can fill them in incrementally and the A/B harness can compare
 * matching SUBSETS of passes.
 *
 * All WebGL2RenderingContext usage lives inside methods (never module top
 * level) so this module imports cleanly under node --test.
 */

import { RenderCore } from "../render-core.ts";
import type { BrainGraph, BrainNode, LobeName, Vec3 } from "../types.ts";
import { sceneProjection, projectPoint } from "./projection.ts";
import type { ProjectionOpts } from "./projection.ts";
import { hexToRgb01 } from "./color.ts";
import { createProgram, getUniformLocations, createStaticBuffer } from "./programs.ts";
import { BACKGROUND_VS, BACKGROUND_FS, HAZE_VS, HAZE_FS, CLOUD_VS, CLOUD_FS, EDGE_VS, EDGE_FS, NODE_VS, NODE_FS, SIGNAL_VS, SIGNAL_FS } from "./shaders.ts";
import { LOBE_CENTERS } from "../shape.ts";
import { lobeVisibilityMultiplier } from "../lobe-visibility.ts";
import { buildBrainCloud } from "../cloud.ts";
import {
  buildCloudBuffer,
  buildEdgeRibbons,
  buildNodeBuffer,
  computeEdgePositionBlock,
  incidentEdgeRanges,
  INDICES_PER_EDGE,
  LOBE_INDEX,
  VERTS_PER_EDGE
} from "./buffers.ts";
import type { EdgePositionBlock, EdgeRibbonBuffer, NodeBuffer, VertexRange } from "./buffers.ts";
import {
  drawLobeLabels as sharedDrawLobeLabels,
  drawNodeLabels as sharedDrawNodeLabels,
  drawCompass as sharedDrawCompass
} from "../overlay-labels.ts";

/**
 * Grace period after a WebGL context loss before giving up and handing off to
 * the Canvas2D fallback. Generous on purpose: most losses (GPU reset, driver
 * hiccup, sleep/wake) restore within a few seconds, so we wait long enough to
 * recover to WebGL instead of permanently downgrading on a transient hiccup.
 */
const CONTEXT_LOST_FALLBACK_MS = 10000;

/**
 * Lobe names ordered by their GPU LOBE_INDEX (0-5). Used to build the 6-entry
 * uLobeMul / uLobeColors uniform arrays in index order.
 */
const LOBE_BY_INDEX: LobeName[] = (() => {
  const arr: LobeName[] = new Array<LobeName>(6);
  for (const name in LOBE_INDEX) {
    arr[LOBE_INDEX[name as LobeName]] = name as LobeName;
  }
  return arr;
})();

/**
 * lerpHex: interpolate two CSS hex colors (#rrggbb or rgb(r,g,b)) in 0-255
 * integer space with Math.round. Matches renderer.ts lerpHex exactly so
 * CPU-computed signal colors are numerically identical to Canvas2D.
 *
 * Both colA and colB are always "#rrggbb" hex strings from node.color.
 */
function lerpHex(a: string, b: string, t: number): [number, number, number] {
  const ha = a.replace("#", "");
  const hb = b.replace("#", "");
  const ar = parseInt(ha.slice(0, 2), 16);
  const ag = parseInt(ha.slice(2, 4), 16);
  const ab = parseInt(ha.slice(4, 6), 16);
  const br = parseInt(hb.slice(0, 2), 16);
  const bg = parseInt(hb.slice(2, 4), 16);
  const bb = parseInt(hb.slice(4, 6), 16);
  return [
    Math.round(ar + (br - ar) * t) / 255,
    Math.round(ag + (bg - ag) * t) / 255,
    Math.round(ab + (bb - ab) * t) / 255
  ];
}

interface SignalProgram {
  program: WebGLProgram;
  /** Dynamic VBO; re-uploaded each frame with the active sub-sprite data. */
  vertexBuffer: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  uniforms: Record<string, WebGLUniformLocation | null>;
  /**
   * Pre-allocated CPU scratch buffer for up to MAX_SIGNAL_SPRITES sprites.
   * 9 floats per vertex × 6 verts per sprite = 54 floats per sprite.
   */
  scratch: Float32Array;
  /** GPU buffer capacity in bytes (allocated once, re-used via bufferSubData). */
  capacityBytes: number;
}

/** Maximum number of signals × sub-sprites the buffer is pre-allocated for. */
const MAX_SIGNAL_SPRITES = 64; // 10 signals × 6 sub-sprites + generous headroom

/** Floats per vertex in the interleaved EDGE VBO (see ensureEdgeProgram layout). */
const EDGE_FLOATS_PER_VERT = 25;
/** Byte offsets (in floats) of the position-derived edge attributes. */
const EDGE_POS_OFFSET = 0;        // aPosition  (3 floats)
const EDGE_TANGENT_OFFSET = 3;    // aTangentRef (3 floats)
const EDGE_SEGSTART_OFFSET = 6;   // aSegStartRef (3 floats)

/** Floats per vertex in the interleaved NODE VBO (see ensureNodeProgram layout). */
const NODE_FLOATS_PER_VERT = 13;
/** Vertices per node quad in the node VBO. */
const NODE_VERTS_PER_NODE = 6;
/**
 * Per-quad corner offsets (two triangles), shared by the node VBO build and the
 * partial node-drag update so the rewritten block has identical winding.
 */
const NODE_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [ 1, -1],
  [-1,  1],
  [-1,  1],
  [ 1, -1],
  [ 1,  1]
];

interface BackgroundProgram {
  program: WebGLProgram;
  quadBuffer: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

interface HazeProgram {
  program: WebGLProgram;
  quadBuffer: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

interface CloudProgram {
  program: WebGLProgram;
  vertexBuffer: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  uniforms: Record<string, WebGLUniformLocation | null>;
  /** Total vertex count (cloud point count * 6 verts per quad). */
  vertexCount: number;
}

interface EdgeProgram {
  program: WebGLProgram;
  /** One interleaved static VBO holding all per-vertex attributes. */
  vertexBuffer: WebGLBuffer;
  /** Dynamic element buffer; re-uploaded each frame with the sorted index order. */
  indexBuffer: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  uniforms: Record<string, WebGLUniformLocation | null>;
  /** The built ribbon buffer (positions, ranges, static index template). */
  buf: EdgeRibbonBuffer;
  /**
   * Per-edge cached centerline points (13 model-space points per edge, flattened
   * as [x0,y0,z0, x1,y1,z1, ...]) for fast per-frame mean-z without re-reading the
   * interleaved VBO. Length = edgeCount * 13 * 3.
   */
  centerline: Float32Array;
  /** Dense edge count (number of valid edges). */
  edgeCount: number;
  /** Per-frame scratch: mean projected z per dense edge index. */
  meanZ: Float32Array;
  /** Per-frame scratch: dense edge indices being sorted for one hemisphere. */
  sortScratch: Int32Array;
  /** Per-frame scratch: the sorted GLOBAL element indices uploaded each draw. */
  indexScratch: Uint32Array;
  /**
   * node-buffer-index → incident edges' vertex ranges. Built once alongside the
   * edge buffer so a node drag can find exactly which edges to partially update
   * (only the dragged node's incident edges, never the whole buffer).
   */
  incidentMap: Map<number, VertexRange[]>;
  /**
   * node-buffer-index → BrainNode, so the partial update can read each incident
   * edge's CURRENT endpoint positions (_3dLobe) from the graph when recomputing
   * its vertex block. The node-buffer index space is the same one nodeIdxA/B use.
   */
  bufIndexToNode: BrainNode[];
  /** Reusable scratch for one edge's recomputed position-derived block (drag update). */
  posBlockScratch: EdgePositionBlock;
  /** Reusable scratch for uploading one edge's 26-vertex interleaved sub-block. */
  edgeUploadScratch: Float32Array;
}

interface NodeProgram {
  program: WebGLProgram;
  /** One interleaved static VBO holding all per-vertex attributes (6 verts/node). */
  vertexBuffer: WebGLBuffer;
  /** Dynamic element buffer; re-uploaded each frame with the sorted node-quad order. */
  indexBuffer: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  uniforms: Record<string, WebGLUniformLocation | null>;
  /** Built node buffer (positions, radii, flags, colors). */
  buf: NodeBuffer;
  /**
   * Per-node model-space center (flattened [x0,y0,z0, x1,...]) for fast per-frame
   * z-only projection without re-reading the interleaved VBO. Length = count*3.
   */
  centers: Float32Array;
  /** Node count (number of _3dLobe nodes). */
  nodeCount: number;
  /** Per-frame scratch: projected z per node. */
  projZ: Float32Array;
  /** Per-frame scratch: dense node indices being sorted for one hemisphere. */
  sortScratch: Int32Array;
  /**
   * Static element-index template: 6 indices per node quad (two triangles), LOCAL
   * to the node's 6-vertex range (0-5) offset by node*6 to make them global.
   * The renderer re-uploads sorted 6-index blocks each frame for one indexed draw.
   */
  baseIndices: Uint32Array;
  /** Per-frame scratch: the sorted GLOBAL element indices uploaded each draw. */
  indexScratch: Uint32Array;
}

export class BrainGLRenderer extends RenderCore {
  private gl: WebGL2RenderingContext | null = null;
  private overlay: HTMLCanvasElement | null = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;

  // Lazily created GL resources (created once, reused across frames).
  private bgProgram: BackgroundProgram | null = null;
  private hazeProgram: HazeProgram | null = null;
  private cloudProgram: CloudProgram | null = null;
  private edgeProgram: EdgeProgram | null = null;
  /** Identity of the graph the edge buffers were built from (rebuild on change). */
  private edgeGraph: BrainGraph | null = null;
  private nodeProgram: NodeProgram | null = null;
  /** Identity of the graph the node buffers were built from (rebuild on change). */
  private nodeGraph: BrainGraph | null = null;
  private signalProgram: SignalProgram | null = null;
  /** Reusable scratch for uploading one node's 6-vertex interleaved block (drag update). */
  private nodeUploadScratch = new Float32Array(NODE_VERTS_PER_NODE * NODE_FLOATS_PER_VERT);

  // ---- Context-loss state ----
  /** True between webglcontextlost and webglcontextrestored (or permanent loss). */
  private contextLost = false;
  /**
   * Timer started on context loss. If webglcontextrestored hasn't fired within
   * ~1.5 s we treat the loss as permanent and call onRendererUnavailable().
   */
  private contextLostTimer: number | null = null;
  /** Guard: once unavailable is called we never call it again (re-entrancy safety). */
  private unavailableCalled = false;

  // Bound event handlers so we can remove the exact same function references on
  // releaseSurface (avoiding duplicate handlers across onHide→onShow cycles).
  private readonly onContextLost = (event: Event): void => {
    // REQUIRED: without preventDefault the browser will NOT fire contextrestored.
    event.preventDefault();
    this.contextLost = true;

    // Stop the render loop so drawScene never runs against a dead context.
    if (this.raf != null) { window.cancelAnimationFrame(this.raf); this.raf = null; }
    if (this.frameTimeout != null) { window.clearTimeout(this.frameTimeout); this.frameTimeout = null; }

    // Start a generous fallback timer. Most context losses (GPU reset, driver
    // hiccup, laptop sleep/wake) restore within a few seconds, so we wait long
    // enough to recover to WebGL rather than prematurely (and permanently)
    // dropping to Canvas2D. Only a genuinely permanent loss reaches this timeout
    // and hands off to the view's Canvas2D fallback.
    if (this.contextLostTimer != null) window.clearTimeout(this.contextLostTimer);
    this.contextLostTimer = window.setTimeout(() => {
      this.contextLostTimer = null;
      // Still lost after the grace period → treat as permanent.
      if (this.contextLost) this.callUnavailable();
    }, CONTEXT_LOST_FALLBACK_MS);
  };

  private readonly onContextRestored = (): void => {
    // Cancel the fallback timer — restore arrived in time.
    if (this.contextLostTimer != null) {
      window.clearTimeout(this.contextLostTimer);
      this.contextLostTimer = null;
    }

    // Null out every cached program and buffer-cache identity so they rebuild
    // lazily on the next drawScene. DO NOT call gl.deleteXxx here — the context
    // was lost, so all GL objects are already invalid; the browser discards them.
    // DO NOT call getContext again — the same context object is reused after restore.
    this.bgProgram = null;
    this.hazeProgram = null;
    this.cloudProgram = null;
    this.edgeProgram = null;
    this.edgeGraph = null;
    this.nodeProgram = null;
    this.nodeGraph = null;
    this.signalProgram = null;

    this.contextLost = false;

    // Re-apply viewport from the current canvas dimensions.
    try {
      if (this.gl && this.canvas) {
        this.resizeSurface();
      }
      // Resume the render loop.
      this.requestImmediateFrame();
    } catch {
      // Resource rebuild failed on restore — treat as permanent loss.
      this.callUnavailable();
    }
  };

  /**
   * Invoke the onRendererUnavailable callback (at most once, re-entrancy-safe).
   * Called when context loss is permanent (timer expires) or restore fails.
   */
  private callUnavailable(): void {
    if (this.unavailableCalled) return;
    this.unavailableCalled = true;
    this.options.onRendererUnavailable?.();
  }

  protected acquireSurface(canvas: HTMLCanvasElement): boolean {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true
    });
    if (!gl) return false;
    this.gl = gl;

    // Reset the unavailable-called guard so a fresh start (after stop+start) can
    // invoke the callback again if a new loss occurs on the new context.
    this.unavailableCalled = false;
    this.contextLost = false;

    // Register context-loss/restore listeners. Store bound method references so
    // releaseSurface can remove the EXACT same functions (no duplicate handlers
    // across onHide→onShow restart cycles).
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);

    // Create the overlay canvas as a sibling that exactly overlaps the WebGL
    // canvas. It sits above the WebGL canvas and ignores pointer events so the
    // WebGL canvas remains the interaction target.
    const overlay = canvas.ownerDocument.createElement("canvas");
    // Positioning/pointer styles live in styles.css (.brain-atlas-gl-overlay)
    // per Obsidian's no-static-styles policy.
    overlay.classList.add("brain-atlas-gl-overlay");
    const parent = canvas.parentElement;
    if (parent) {
      // Append after the WebGL canvas so it renders on top in DOM order.
      parent.appendChild(overlay);
    }
    this.overlay = overlay;
    this.overlayCtx = overlay.getContext("2d");

    return true;
  }

  protected isReady(): boolean {
    return !!this.gl && !this.contextLost;
  }

  /**
   * Test-only: the overlay canvas, so the A/B harness can composite WebGL +
   * overlay into a single readback image.
   */
  getOverlayCanvasForTest(): HTMLCanvasElement | null {
    return this.overlay;
  }

  /**
   * Test-only: simulate a WebGL context loss via the WEBGL_lose_context extension.
   * Fires the real webglcontextlost event asynchronously (browser-driven), which
   * causes the renderer to stop drawing and start the 1.5 s fallback timer.
   * Must call restoreContextForTest() afterwards to bring the context back.
   */
  loseContextForTest(): void {
    const ext = this.gl?.getExtension("WEBGL_lose_context");
    ext?.loseContext();
  }

  /**
   * Test-only: restore a context previously lost via loseContextForTest().
   * Fires the real webglcontextrestored event asynchronously (browser-driven),
   * which triggers lazy resource rebuild and resumes the render loop.
   */
  restoreContextForTest(): void {
    const ext = this.gl?.getExtension("WEBGL_lose_context");
    ext?.restoreContext();
  }

  /**
   * Test-only: read the current contextLost flag without triggering any side effects.
   */
  isContextLostForTest(): boolean {
    return this.contextLost;
  }

  protected resizeSurface(): void {
    const gl = this.gl;
    if (!this.canvas || !gl) return;
    const wDpr = Math.floor(this.width * this.dpr);
    const hDpr = Math.floor(this.height * this.dpr);

    // WebGL canvas backing store + CSS size.
    this.canvas.width = wDpr;
    this.canvas.height = hDpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    gl.viewport(0, 0, wDpr, hDpr);

    // Overlay canvas: same backing store, same CSS box, dpr transform so 2D
    // drawing uses CSS pixels exactly like the Canvas2D renderer.
    if (this.overlay) {
      this.overlay.width = wDpr;
      this.overlay.height = hDpr;
      this.overlay.style.width = `${this.width}px`;
      this.overlay.style.height = `${this.height}px`;
    }
    if (this.overlayCtx) {
      this.overlayCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
  }

  protected releaseSurface(): void {
    // Remove context-loss/restore listeners before any other cleanup to avoid
    // a spurious restore handler firing after we've deliberately stopped.
    if (this.canvas) {
      this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
      this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    }

    // Clear the fallback timer (stop any pending permanent-loss notification).
    if (this.contextLostTimer != null) {
      window.clearTimeout(this.contextLostTimer);
      this.contextLostTimer = null;
    }

    const gl = this.gl;
    // Only delete GL objects if the context is NOT currently lost. When the
    // context is lost these handles are already invalid; calling delete on a
    // lost context is a no-op or may error, so we skip it safely.
    if (gl && !this.contextLost) {
      if (this.bgProgram) {
        gl.deleteVertexArray(this.bgProgram.vao);
        gl.deleteBuffer(this.bgProgram.quadBuffer);
        gl.deleteProgram(this.bgProgram.program);
      }
      if (this.hazeProgram) {
        gl.deleteVertexArray(this.hazeProgram.vao);
        gl.deleteBuffer(this.hazeProgram.quadBuffer);
        gl.deleteProgram(this.hazeProgram.program);
      }
      if (this.cloudProgram) {
        gl.deleteVertexArray(this.cloudProgram.vao);
        gl.deleteBuffer(this.cloudProgram.vertexBuffer);
        gl.deleteProgram(this.cloudProgram.program);
      }
      if (this.edgeProgram) {
        gl.deleteVertexArray(this.edgeProgram.vao);
        gl.deleteBuffer(this.edgeProgram.vertexBuffer);
        gl.deleteBuffer(this.edgeProgram.indexBuffer);
        gl.deleteProgram(this.edgeProgram.program);
      }
      if (this.nodeProgram) {
        gl.deleteVertexArray(this.nodeProgram.vao);
        gl.deleteBuffer(this.nodeProgram.vertexBuffer);
        gl.deleteBuffer(this.nodeProgram.indexBuffer);
        gl.deleteProgram(this.nodeProgram.program);
      }
      if (this.signalProgram) {
        gl.deleteVertexArray(this.signalProgram.vao);
        gl.deleteBuffer(this.signalProgram.vertexBuffer);
        gl.deleteProgram(this.signalProgram.program);
      }
    }
    this.bgProgram = null;
    this.hazeProgram = null;
    this.cloudProgram = null;
    this.edgeProgram = null;
    this.edgeGraph = null;
    this.nodeProgram = null;
    this.nodeGraph = null;
    this.signalProgram = null;

    if (this.overlay && this.overlay.parentElement) {
      this.overlay.parentElement.removeChild(this.overlay);
    }
    this.overlay = null;
    this.overlayCtx = null;
    this.gl = null;
    this.contextLost = false;
  }

  protected drawScene(now: number): void {
    const gl = this.gl;
    const graph = this.getGraph?.();
    // Guard against drawing on a lost or missing context.
    if (!gl || !graph || this.contextLost || gl.isContextLost()) return;

    // Scene projection opts — shared by every geometry pass. For Task 6 only
    // proj.cx / proj.cy feed the background; later tasks use the full opts.
    const proj = sceneProjection(this.width, this.height, this.zoom, this.rot);

    // Clear the overlay each frame; text passes (labels/compass) draw into it.
    if (this.overlayCtx) {
      this.overlayCtx.clearRect(0, 0, this.width, this.height);
    }

    // ---- Pass: background (radial gradient, opaque full-screen quad) ----
    if (this.passEnabled("background")) {
      this.drawBackground(gl, graph, proj.cx, proj.cy);
    }

    // ---- Pass: haze (lobe glow, additive) ----
    if (this.passEnabled("haze")) {
      this.drawHaze(gl, graph, proj);
    }

    // Per-frame 6-entry uniform arrays (lobe visibility multiplier + lobe color),
    // indexed by GPU lobeIndex. These depend only on enabledLobes / highlightLobe
    // / activePalette — never on geometry — so they cost no buffer rebuild.
    const lobeMul = new Float32Array(6);
    const lobeColors = new Float32Array(18);
    for (let i = 0; i < 6; i++) {
      const lobe = LOBE_BY_INDEX[i];
      lobeMul[i] = lobeVisibilityMultiplier(lobe, this.options.enabledLobes, this.highlightLobe);
      const [r, g, b] = hexToRgb01(this.lobeColor(lobe, graph));
      lobeColors[i * 3 + 0] = r;
      lobeColors[i * 3 + 1] = g;
      lobeColors[i * 3 + 2] = b;
    }

    // Back-to-front, hemisphere-interleaved draw order (matches Canvas2D drawScene
    // and leaves clean slots for the edges/nodes passes — Tasks 9-10).
    //
    // Per-frame focus/hover NODE indices (in node-buffer index space — the same
    // index space the edge buffer's nodeIdxA/B reference). -1 = none. Computed once
    // and passed to both edge hemispheres so drawEdge's isFocus/isHover are in-shader.
    const focusIdx = this.nodeBufferIndexOf(graph, this.focusId);
    const hoverIdx = this.nodeBufferIndexOf(graph, this.hoverId);

    // FAR hemisphere (projected z > 0), back of the scene:
    if (this.passEnabled("cloud")) this.drawCloud(gl, proj, now, +1, lobeMul, lobeColors);
    if (this.passEnabled("edges")) this.drawEdges(gl, graph, proj, +1, lobeMul, focusIdx, hoverIdx);
    if (this.passEnabled("nodes")) this.drawNodes(gl, graph, proj, +1, lobeMul, focusIdx, hoverIdx);

    // NEAR hemisphere (projected z <= 0), front of the scene:
    if (this.passEnabled("cloud")) this.drawCloud(gl, proj, now, -1, lobeMul, lobeColors);
    if (this.passEnabled("edges")) this.drawEdges(gl, graph, proj, -1, lobeMul, focusIdx, hoverIdx);
    if (this.passEnabled("nodes")) this.drawNodes(gl, graph, proj, -1, lobeMul, focusIdx, hoverIdx);

    // ---- Pass: signals (additive particle trails) ----
    if (this.passEnabled("signals")) this.drawSignals(gl, proj, now);

    // ---- Pass: labels (lobe + node labels, overlay 2D) ----
    if (this.passEnabled("labels") && this.overlayCtx && this.options.showLobeLabels) {
      const overlayCtx = this.overlayCtx;
      // Build the scene projector as a (point)=>ProjectedPoint closure (same params
      // as Canvas2D drawScene uses for lobe labels).
      const lobeProject = (point: Vec3) => projectPoint(proj, point);
      const lobeStats = this.getLobeStats();
      const scalarLobeMul = (lobe?: LobeName) =>
        lobeVisibilityMultiplier(lobe, this.options.enabledLobes, this.highlightLobe);
      // Build nodeProjs from the projCache populated by draw() in RenderCore.
      const nodeProjs = Object.values(this.projCache);
      sharedDrawLobeLabels(overlayCtx, lobeProject, graph, lobeStats, scalarLobeMul, (lobe) => this.lobeColor(lobe, graph));
      sharedDrawNodeLabels(overlayCtx, nodeProjs, graph, scalarLobeMul, {
        hoverId: this.hoverId,
        focusId: this.focusId,
        zoom: this.zoom,
        width: this.width,
        mobile: this.effectivePerformancePreset() === "mobile"
      });
    }

    // ---- Pass: compass (orientation gizmo, overlay 2D) ----
    if (this.passEnabled("compass") && this.overlayCtx) {
      sharedDrawCompass(this.overlayCtx, this.rot, graph, this.width, this.height);
    }
  }

  /** Lazily create + return the background program (full-screen quad). */
  private ensureBackgroundProgram(gl: WebGL2RenderingContext): BackgroundProgram {
    if (this.bgProgram) return this.bgProgram;
    const program = createProgram(gl, BACKGROUND_VS, BACKGROUND_FS);
    const aPosition = gl.getAttribLocation(program, "aPosition");
    // Two triangles covering clip space [-1, 1].
    const quad = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1
    ]);
    const quadBuffer = createStaticBuffer(gl, quad);

    // VAO captures the buffer binding + attrib layout so drawBackground never
    // touches buffer/attrib state per-frame. This is the template every later
    // pass (Tasks 7-11) should follow: create VAO at program-init time, bind it
    // in draw, unbind after the draw call.
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("Brain Atlas: failed to create background VAO.");
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const uniforms = getUniformLocations(gl, program, [
      "uResolution",
      "uDpr",
      "uCenter",
      "uRadius",
      "uBg",
      "uBgFar"
    ]);
    this.bgProgram = { program, quadBuffer, vao, uniforms };
    return this.bgProgram;
  }

  /** Draw the radial-gradient background as an opaque full-screen quad. */
  private drawBackground(gl: WebGL2RenderingContext, graph: BrainGraph, cx: number, cy: number): void {
    const bg = this.ensureBackgroundProgram(gl);
    const pal = graph.activePalette;
    const [bgR, bgG, bgB] = hexToRgb01(pal.bg);
    const [farR, farG, farB] = hexToRgb01(pal.bgFar);
    const radius = Math.max(this.width, this.height) * 0.75;

    // Background is opaque: no blending, just paint the quad over the framebuffer.
    // Pass blend convention: each pass explicitly sets (or disables) blending at
    // its start so passes compose correctly regardless of execution order.
    gl.disable(gl.BLEND);

    gl.useProgram(bg.program);
    gl.bindVertexArray(bg.vao);

    gl.uniform2f(bg.uniforms.uResolution, Math.floor(this.width * this.dpr), Math.floor(this.height * this.dpr));
    gl.uniform1f(bg.uniforms.uDpr, this.dpr);
    gl.uniform2f(bg.uniforms.uCenter, cx, cy);
    gl.uniform1f(bg.uniforms.uRadius, radius);
    gl.uniform3f(bg.uniforms.uBg, bgR, bgG, bgB);
    gl.uniform3f(bg.uniforms.uBgFar, farR, farG, farB);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  /** Lazily create + return the haze program (unit quad, per-lobe draw calls). */
  private ensureHazeProgram(gl: WebGL2RenderingContext): HazeProgram {
    if (this.hazeProgram) return this.hazeProgram;
    const program = createProgram(gl, HAZE_VS, HAZE_FS);
    const aPosition = gl.getAttribLocation(program, "aPosition");
    // Unit quad [-1, 1]² covering exactly the haze circle's bounding square.
    // The vertex shader scales+translates it to screen space per draw call.
    const quad = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1
    ]);
    const quadBuffer = createStaticBuffer(gl, quad);

    // VAO captures the buffer+attrib layout (same pattern as ensureBackgroundProgram).
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("Brain Atlas: failed to create haze VAO.");
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const uniforms = getUniformLocations(gl, program, [
      "uResolution",
      "uDpr",
      "uCenter",
      "uRadius",
      "uColor",
      "uBaseA"
    ]);
    this.hazeProgram = { program, quadBuffer, vao, uniforms };
    return this.hazeProgram;
  }

  /**
   * Draw the lobe-haze pass: one additive radial-gradient quad per lobe (+ mirror).
   *
   * Blend convention: additive (ONE, ONE). Set at the start of this pass and
   * disabled afterward. Later passes set their own blend modes explicitly.
   *
   * Draw order: Canvas2D sorts quads by pr.z descending, but additive blending
   * is commutative — accumulation order does not affect the result. We skip the
   * sort here (each quad's contribution is independent).
   */
  private drawHaze(gl: WebGL2RenderingContext, graph: BrainGraph, proj: ProjectionOpts): void {
    const hz = this.ensureHazeProgram(gl);

    // Haze uses additive blending (same as Canvas2D "lighter" composite operation).
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.useProgram(hz.program);
    gl.bindVertexArray(hz.vao);

    const wDpr = Math.floor(this.width * this.dpr);
    const hDpr = Math.floor(this.height * this.dpr);
    gl.uniform2f(hz.uniforms.uResolution, wDpr, hDpr);
    gl.uniform1f(hz.uniforms.uDpr, this.dpr);

    // sceneScale = proj.scale = min(w,h) * 0.32 * zoom
    const sceneScale = proj.scale;

    for (const rawLobe in LOBE_CENTERS) {
      const lobe = rawLobe as LobeName;
      const lobeCenter = LOBE_CENTERS[lobe];

      // Draw the primary center and, if mirrored, the mirror.
      const centers = [lobeCenter.c];
      if (lobeCenter.mirror) {
        centers.push({ x: -lobeCenter.c.x, y: lobeCenter.c.y, z: lobeCenter.c.z });
      }

      for (const center of centers) {
        const pr = projectPoint(proj, center);

        // radius = lobeCenter.r * sceneScale * 1.4 * pr.scale
        const radius = lobeCenter.r * sceneScale * 1.4 * pr.scale;

        // depthFade = max(0.25, 1 - pr.depth * 0.55)
        const depthFade = Math.max(0.25, 1 - pr.depth * 0.55);

        // baseA = (highlight ? 0.18 : 0.07) * depthFade * lobeVisibilityMultiplier(...)
        const highlightMul = this.highlightLobe === lobe ? 0.18 : 0.07;
        const baseA = highlightMul * depthFade * lobeVisibilityMultiplier(lobe, this.options.enabledLobes, this.highlightLobe);

        if (baseA < 0.005) continue;

        const [r, g, b] = hexToRgb01(this.lobeColor(lobe, graph));

        gl.uniform2f(hz.uniforms.uCenter, pr.sx, pr.sy);
        gl.uniform1f(hz.uniforms.uRadius, radius);
        gl.uniform3f(hz.uniforms.uColor, r, g, b);
        gl.uniform1f(hz.uniforms.uBaseA, baseA);

        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    gl.bindVertexArray(null);

    // Restore blend state: disable blend so subsequent opaque passes (if any)
    // are not affected. Each pass sets its own blend mode at its start.
    gl.disable(gl.BLEND);
  }

  /**
   * Lazily create + return the cloud program. Builds the STATIC point-sprite
   * buffer once: each of the ~1648 cloud points is expanded into a quad (6
   * vertices via 2 triangles), interleaving model xyz, lobeIndex, phase, freq,
   * and a per-vertex [-1,1]² corner offset.
   *
   * The cloud points come from buildBrainCloud() — the SAME pure builder the
   * Canvas2D renderer uses — so both renderers project byte-identical points.
   */
  private ensureCloudProgram(gl: WebGL2RenderingContext): CloudProgram {
    if (this.cloudProgram) return this.cloudProgram;
    const program = createProgram(gl, CLOUD_VS, CLOUD_FS);

    const cloud = buildBrainCloud();
    const buf = buildCloudBuffer(cloud);
    const count = buf.count;

    // 8 floats per vertex: [x, y, z, lobeIndex, phase, freq, cornerX, cornerY].
    // 6 vertices per point (two triangles covering the [-1,1]² corner space).
    const FLOATS_PER_VERT = 8;
    const VERTS_PER_POINT = 6;
    // Corner offsets matching the bg/haze quad winding (two triangles).
    const corners = [
      [-1, -1],
      [ 1, -1],
      [-1,  1],
      [-1,  1],
      [ 1, -1],
      [ 1,  1]
    ];
    const vertexCount = count * VERTS_PER_POINT;
    const data = new Float32Array(vertexCount * FLOATS_PER_VERT);
    let o = 0;
    for (let i = 0; i < count; i++) {
      const x = buf.positions[i * 3 + 0];
      const y = buf.positions[i * 3 + 1];
      const z = buf.positions[i * 3 + 2];
      const lobe = buf.lobeIndex[i];
      const phase = buf.phase[i];
      const freq = buf.freq[i];
      for (let c = 0; c < VERTS_PER_POINT; c++) {
        data[o++] = x;
        data[o++] = y;
        data[o++] = z;
        data[o++] = lobe;
        data[o++] = phase;
        data[o++] = freq;
        data[o++] = corners[c][0];
        data[o++] = corners[c][1];
      }
    }

    const vertexBuffer = createStaticBuffer(gl, data);

    const aPosition = gl.getAttribLocation(program, "aPosition");
    const aLobeIndex = gl.getAttribLocation(program, "aLobeIndex");
    const aPhase = gl.getAttribLocation(program, "aPhase");
    const aFreq = gl.getAttribLocation(program, "aFreq");
    const aCorner = gl.getAttribLocation(program, "aCorner");

    const vao = gl.createVertexArray();
    if (!vao) throw new Error("Brain Atlas: failed to create cloud VAO.");
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    const stride = FLOATS_PER_VERT * 4; // bytes
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(aLobeIndex);
    gl.vertexAttribPointer(aLobeIndex, 1, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(aPhase);
    gl.vertexAttribPointer(aPhase, 1, gl.FLOAT, false, stride, 4 * 4);
    gl.enableVertexAttribArray(aFreq);
    gl.vertexAttribPointer(aFreq, 1, gl.FLOAT, false, stride, 5 * 4);
    gl.enableVertexAttribArray(aCorner);
    gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, stride, 6 * 4);
    gl.bindVertexArray(null);

    const uniforms = getUniformLocations(gl, program, [
      "uResolution",
      "uDpr",
      "uRotX",
      "uRotY",
      "uSceneScale",
      "uCx",
      "uCy",
      "uDist",
      "uTime",
      "uHemisphere",
      "uLobeMul[0]",
      "uLobeColors[0]"
    ]);
    this.cloudProgram = { program, vertexBuffer, vao, uniforms, vertexCount };
    return this.cloudProgram;
  }

  /**
   * Draw the cloud point-sprite pass for one hemisphere.
   *
   * hemisphere = +1 draws far points (projected z > 0); -1 draws near points
   * (z <= 0). The vertex shader culls quads whose far-ness doesn't match, so a
   * single static buffer serves both passes. This reproduces Canvas2D's two
   * cloud loops (far cloud BEFORE the far edges/nodes slot, near cloud AFTER).
   *
   * Blend: additive (ONE, ONE) — matches Canvas2D "lighter". Additive is
   * commutative, so accumulation order within a hemisphere is irrelevant.
   */
  private drawCloud(
    gl: WebGL2RenderingContext,
    proj: ProjectionOpts,
    now: number,
    hemisphere: 1 | -1,
    lobeMul: Float32Array,
    lobeColors: Float32Array
  ): void {
    const cp = this.ensureCloudProgram(gl);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.useProgram(cp.program);
    gl.bindVertexArray(cp.vao);

    const wDpr = Math.floor(this.width * this.dpr);
    const hDpr = Math.floor(this.height * this.dpr);
    gl.uniform2f(cp.uniforms.uResolution, wDpr, hDpr);
    gl.uniform1f(cp.uniforms.uDpr, this.dpr);
    gl.uniform1f(cp.uniforms.uRotX, proj.rotX);
    gl.uniform1f(cp.uniforms.uRotY, proj.rotY);
    gl.uniform1f(cp.uniforms.uSceneScale, proj.scale);
    gl.uniform1f(cp.uniforms.uCx, proj.cx);
    gl.uniform1f(cp.uniforms.uCy, proj.cy);
    gl.uniform1f(cp.uniforms.uDist, proj.dist);
    gl.uniform1f(cp.uniforms.uTime, now);
    gl.uniform1f(cp.uniforms.uHemisphere, hemisphere);
    gl.uniform1fv(cp.uniforms["uLobeMul[0]"], lobeMul);
    gl.uniform3fv(cp.uniforms["uLobeColors[0]"], lobeColors);

    gl.drawArrays(gl.TRIANGLES, 0, cp.vertexCount);

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  /**
   * Partial buffer update on node drag.
   *
   * moveNodeTo (RenderCore) has already mutated node._3dLobe on the SAME graph
   * object, so the static node + edge VBOs (cached by graph identity) are stale
   * for the dragged node and its incident edges. Rather than rebuild the whole
   * geometry per pointermove, we recompute ONLY:
   *   - the dragged node's 6-vertex block in the node VBO (position changes), and
   *   - each INCIDENT edge's 26-vertex block in the edge VBO (an endpoint moved,
   *     so its centerline / tangentRef / segStartRef change),
   * and gl.bufferSubData just those byte ranges. The flat color/segment/node-index
   * attributes are untouched (a move does not affect them). Cost scales with the
   * dragged node's degree, NOT the total edge count — a hub drag updates only that
   * hub's incident edges (a few dozen), never all ~4000.
   *
   * Dynamic per-frame state (signals buffer, projCache hit-test) already follows
   * the drag because they re-read _3dLobe each frame; only these static VBOs need
   * the explicit partial update.
   */
  protected onNodeMoved(nodeId: string): void {
    const gl = this.gl;
    const graph = this.getGraph?.();
    if (!gl || !graph) return;

    const bufIdx = this.nodeBufferIndexOf(graph, nodeId);
    if (bufIdx < 0) return; // node has no _3dLobe / not in the buffer

    const node = graph.idx[nodeId];
    const pos = node?._3dLobe;
    if (!pos) return;

    // ---- Node VBO: rewrite the dragged node's 6-vertex block (position only) ----
    // The node program may not have been built yet (first draw lazily builds it).
    // If it exists, patch it; otherwise the first build will read the new _3dLobe.
    const np = this.nodeProgram;
    if (np && this.nodeGraph === graph && bufIdx < np.nodeCount) {
      // Update the cached model center (used by the per-frame z-only sort).
      np.centers[bufIdx * 3 + 0] = pos.x;
      np.centers[bufIdx * 3 + 1] = pos.y;
      np.centers[bufIdx * 3 + 2] = pos.z;
      // Keep buf.positions consistent too (source of truth for any future rebuild path).
      np.buf.positions[bufIdx * 3 + 0] = pos.x;
      np.buf.positions[bufIdx * 3 + 1] = pos.y;
      np.buf.positions[bufIdx * 3 + 2] = pos.z;

      // Read the node's existing interleaved 6-vertex block, overwrite only the
      // position floats (offset 0-2 of each vertex), upload that byte range.
      const F = NODE_FLOATS_PER_VERT;
      const block = this.nodeUploadScratch;
      // Reconstruct the 6-vertex block from buf (all attrs are per-node constant).
      const r = np.buf.radius[bufIdx];
      const hub = np.buf.hub[bufIdx];
      const status = np.buf.status[bufIdx];
      const lobe = np.buf.lobeIndex[bufIdx];
      const cr = np.buf.color[bufIdx * 3 + 0];
      const cg = np.buf.color[bufIdx * 3 + 1];
      const cb = np.buf.color[bufIdx * 3 + 2];
      const nIdx = np.buf.nodeIndex[bufIdx];
      // Corner offsets must match ensureNodeProgram's winding exactly.
      const corners = NODE_CORNERS;
      for (let c = 0; c < NODE_VERTS_PER_NODE; c++) {
        let o = c * F;
        block[o++] = pos.x;
        block[o++] = pos.y;
        block[o++] = pos.z;
        block[o++] = r;
        block[o++] = hub;
        block[o++] = status;
        block[o++] = lobe;
        block[o++] = cr;
        block[o++] = cg;
        block[o++] = cb;
        block[o++] = nIdx;
        block[o++] = corners[c][0];
        block[o++] = corners[c][1];
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, np.vertexBuffer);
      const byteOffset = bufIdx * NODE_VERTS_PER_NODE * F * 4;
      gl.bufferSubData(gl.ARRAY_BUFFER, byteOffset, block);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    // ---- Edge VBO: rewrite each INCIDENT edge's 26-vertex block ----
    const ep = this.edgeProgram;
    if (ep && this.edgeGraph === graph) {
      const incident = ep.incidentMap.get(bufIdx);
      if (incident && incident.length > 0) {
        for (const range of incident) {
          this.updateEdgeBlock(gl, ep, range.start);
        }
      }
    }

    this.requestImmediateFrame();
  }

  /**
   * Recompute and upload ONE incident edge's 26-vertex interleaved block after an
   * endpoint moved. Reads the edge's two endpoint node-buffer indices from buf
   * (constant per edge), pulls their CURRENT _3dLobe positions from the graph,
   * recomputes the position-derived attributes (aPosition/tangentRef/segStartRef)
   * via the shared computeEdgePositionBlock (same code the full build uses), and
   * leaves every other attribute (colors, sameLobe, selectors, node/lobe indices)
   * exactly as built. Also refreshes buf.positions/tangentRef/segStartRef and the
   * cached centerline so the per-frame mean-z sort follows the move.
   *
   * @param start global vertex index where this edge's block begins.
   */
  private updateEdgeBlock(gl: WebGL2RenderingContext, ep: EdgeProgram, start: number): void {
    const buf = ep.buf;
    // The two endpoints' node-buffer indices are constant per edge; read from the
    // first vertex of this edge's block.
    const idxA = buf.nodeIdxA[start];
    const idxB = buf.nodeIdxB[start];
    const nodeA = ep.bufIndexToNode[idxA];
    const nodeB = ep.bufIndexToNode[idxB];
    const aPos = nodeA?._3dLobe;
    const bPos = nodeB?._3dLobe;
    if (!aPos || !bPos) return;

    // Recompute the position-derived block from the CURRENT endpoint positions.
    const block = computeEdgePositionBlock(aPos, bPos, ep.posBlockScratch);

    const F = EDGE_FLOATS_PER_VERT;
    const out = ep.edgeUploadScratch;
    const edgeIdxBase = start / VERTS_PER_EDGE; // dense edge index (start is a multiple of 26)

    for (let lv = 0; lv < VERTS_PER_EDGE; lv++) {
      const gv = start + lv; // global vertex index
      // Refresh the CPU-side source arrays (positions/tangent/segStart) so any
      // later full rebuild or mean-z read sees the moved geometry.
      buf.positions[gv * 3 + 0] = block.positions[lv * 3 + 0];
      buf.positions[gv * 3 + 1] = block.positions[lv * 3 + 1];
      buf.positions[gv * 3 + 2] = block.positions[lv * 3 + 2];
      buf.tangentRef[gv * 3 + 0] = block.tangentRef[lv * 3 + 0];
      buf.tangentRef[gv * 3 + 1] = block.tangentRef[lv * 3 + 1];
      buf.tangentRef[gv * 3 + 2] = block.tangentRef[lv * 3 + 2];
      buf.segStartRef[gv * 3 + 0] = block.segStartRef[lv * 3 + 0];
      buf.segStartRef[gv * 3 + 1] = block.segStartRef[lv * 3 + 1];
      buf.segStartRef[gv * 3 + 2] = block.segStartRef[lv * 3 + 2];

      // Build the interleaved 25-float vertex: position-derived from the block,
      // every other attribute copied unchanged from buf (a move never alters them).
      let o = lv * F;
      out[o + EDGE_POS_OFFSET + 0] = block.positions[lv * 3 + 0];
      out[o + EDGE_POS_OFFSET + 1] = block.positions[lv * 3 + 1];
      out[o + EDGE_POS_OFFSET + 2] = block.positions[lv * 3 + 2];
      out[o + EDGE_TANGENT_OFFSET + 0] = block.tangentRef[lv * 3 + 0];
      out[o + EDGE_TANGENT_OFFSET + 1] = block.tangentRef[lv * 3 + 1];
      out[o + EDGE_TANGENT_OFFSET + 2] = block.tangentRef[lv * 3 + 2];
      out[o + EDGE_SEGSTART_OFFSET + 0] = block.segStartRef[lv * 3 + 0];
      out[o + EDGE_SEGSTART_OFFSET + 1] = block.segStartRef[lv * 3 + 1];
      out[o + EDGE_SEGSTART_OFFSET + 2] = block.segStartRef[lv * 3 + 2];
      // 9: side, 10-12: colorA, 13-15: colorB, 16-18: focusColor, 19: sameLobe,
      // 20: colorSelector, 21: lobeIdxA, 22: lobeIdxB, 23: nodeIdxA, 24: nodeIdxB.
      out[o + 9] = buf.sides[gv];
      out[o + 10] = buf.colorA[gv * 3 + 0];
      out[o + 11] = buf.colorA[gv * 3 + 1];
      out[o + 12] = buf.colorA[gv * 3 + 2];
      out[o + 13] = buf.colorB[gv * 3 + 0];
      out[o + 14] = buf.colorB[gv * 3 + 1];
      out[o + 15] = buf.colorB[gv * 3 + 2];
      out[o + 16] = buf.focusColor[gv * 3 + 0];
      out[o + 17] = buf.focusColor[gv * 3 + 1];
      out[o + 18] = buf.focusColor[gv * 3 + 2];
      out[o + 19] = buf.sameLobe[gv];
      out[o + 20] = buf.colorSelector[gv];
      out[o + 21] = buf.lobeIdxA[gv];
      out[o + 22] = buf.lobeIdxB[gv];
      out[o + 23] = buf.nodeIdxA[gv];
      out[o + 24] = buf.nodeIdxB[gv];
    }

    // Refresh the cached centerline (13 side=-1 points) used by the mean-z sort.
    const cl = ep.centerline;
    for (let j = 0; j < 13; j++) {
      const lv = j * 2; // side=-1 vertex of tIdx j
      const c = (edgeIdxBase * 13 + j) * 3;
      cl[c + 0] = block.positions[lv * 3 + 0];
      cl[c + 1] = block.positions[lv * 3 + 1];
      cl[c + 2] = block.positions[lv * 3 + 2];
    }

    // Upload only this edge's 26-vertex byte range.
    gl.bindBuffer(gl.ARRAY_BUFFER, ep.vertexBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, start * F * 4, out);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /**
   * Node-buffer index of `id` (the index space the edge buffer's nodeIdxA/B use:
   * position among graph.nodes that have _3dLobe, 0-based). Returns -1 if absent.
   * Matches the nodeBufferIdx map built in buildEdgeRibbons / buildNodeBuffer.
   */
  private nodeBufferIndexOf(graph: BrainGraph, id: string | null): number {
    if (!id) return -1;
    let idx = 0;
    for (const node of graph.nodes) {
      if (!node._3dLobe) continue;
      if (node.id === id) return idx;
      idx += 1;
    }
    return -1;
  }

  /**
   * Lazily build the edge ribbon program + static VBO + the dynamic element buffer.
   * Rebuilds (rebuilding the geometry) when the graph identity changes.
   *
   * The interleaved static VBO holds every per-vertex attribute (positions,
   * tangentRef, segStartRef, side, colors, sameLobe, colorSelector, lobe/node
   * indices). The element buffer is DYNAMIC: drawEdges re-uploads a sorted slice
   * of global indices each frame so a single indexed draw renders one hemisphere
   * back-to-front.
   */
  private ensureEdgeProgram(gl: WebGL2RenderingContext, graph: BrainGraph): EdgeProgram {
    if (this.edgeProgram && this.edgeGraph === graph) return this.edgeProgram;

    // Graph changed (or first build): tear down any prior program/buffers.
    if (this.edgeProgram) {
      gl.deleteVertexArray(this.edgeProgram.vao);
      gl.deleteBuffer(this.edgeProgram.vertexBuffer);
      gl.deleteBuffer(this.edgeProgram.indexBuffer);
      gl.deleteProgram(this.edgeProgram.program);
      this.edgeProgram = null;
    }

    const program = createProgram(gl, EDGE_VS, EDGE_FS);
    const buf = buildEdgeRibbons(graph);
    const edgeCount = buf.edgeRanges.length;
    const vCount = buf.vertexCount;

    // Interleaved layout (floats per vertex):
    //   pos(3) tangentRef(3) segStartRef(3) side(1)
    //   colorA(3) colorB(3) focusColor(3) sameLobe(1)
    //   colorSelector(1) lobeIdxA(1) lobeIdxB(1) nodeIdxA(1) nodeIdxB(1)
    // = 25 floats.
    const F = 25;
    const data = new Float32Array(vCount * F);
    for (let v = 0; v < vCount; v++) {
      let o = v * F;
      data[o++] = buf.positions[v * 3 + 0];
      data[o++] = buf.positions[v * 3 + 1];
      data[o++] = buf.positions[v * 3 + 2];
      data[o++] = buf.tangentRef[v * 3 + 0];
      data[o++] = buf.tangentRef[v * 3 + 1];
      data[o++] = buf.tangentRef[v * 3 + 2];
      data[o++] = buf.segStartRef[v * 3 + 0];
      data[o++] = buf.segStartRef[v * 3 + 1];
      data[o++] = buf.segStartRef[v * 3 + 2];
      data[o++] = buf.sides[v];
      data[o++] = buf.colorA[v * 3 + 0];
      data[o++] = buf.colorA[v * 3 + 1];
      data[o++] = buf.colorA[v * 3 + 2];
      data[o++] = buf.colorB[v * 3 + 0];
      data[o++] = buf.colorB[v * 3 + 1];
      data[o++] = buf.colorB[v * 3 + 2];
      data[o++] = buf.focusColor[v * 3 + 0];
      data[o++] = buf.focusColor[v * 3 + 1];
      data[o++] = buf.focusColor[v * 3 + 2];
      data[o++] = buf.sameLobe[v];
      data[o++] = buf.colorSelector[v];
      data[o++] = buf.lobeIdxA[v];
      data[o++] = buf.lobeIdxB[v];
      data[o++] = buf.nodeIdxA[v];
      data[o++] = buf.nodeIdxB[v];
    }
    const vertexBuffer = createStaticBuffer(gl, data);

    // Cache per-edge centerline points (13 per edge, side=-1 vertices) for mean-z.
    const centerline = new Float32Array(edgeCount * 13 * 3);
    for (let e = 0; e < edgeCount; e++) {
      const start = buf.edgeRanges[e].start;
      for (let j = 0; j < 13; j++) {
        const v = start + j * 2; // side=-1 vertex of tIdx j
        const c = (e * 13 + j) * 3;
        centerline[c + 0] = buf.positions[v * 3 + 0];
        centerline[c + 1] = buf.positions[v * 3 + 1];
        centerline[c + 2] = buf.positions[v * 3 + 2];
      }
    }

    // Dynamic element buffer sized to hold ALL edges' indices (worst case one
    // hemisphere = all edges). Re-uploaded (bufferSubData) each frame.
    const indexBuffer = gl.createBuffer();
    if (!indexBuffer) throw new Error("Brain Atlas: failed to create edge index buffer.");
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, buf.indices.byteLength, gl.DYNAMIC_DRAW);

    // VAO: bind the interleaved VBO + the element buffer + wire attributes.
    const stride = F * 4;
    const loc = (name: string) => gl.getAttribLocation(program, name);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("Brain Atlas: failed to create edge VAO.");
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    const fattr = (name: string, size: number, offsetFloats: number) => {
      const l = loc(name);
      if (l < 0) return;
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, gl.FLOAT, false, stride, offsetFloats * 4);
    };
    fattr("aPosition", 3, 0);
    fattr("aTangentRef", 3, 3);
    fattr("aSegStartRef", 3, 6);
    fattr("aSide", 1, 9);
    fattr("aColorA", 3, 10);
    fattr("aColorB", 3, 13);
    fattr("aFocusColor", 3, 16);
    fattr("aSameLobe", 1, 19);
    fattr("aColorSelector", 1, 20);
    fattr("aLobeIdxA", 1, 21);
    fattr("aLobeIdxB", 1, 22);
    fattr("aNodeIdxA", 1, 23);
    fattr("aNodeIdxB", 1, 24);
    // Bind the element buffer INSIDE the VAO so it is captured by the VAO state.
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bindVertexArray(null);

    const uniforms = getUniformLocations(gl, program, [
      "uResolution",
      "uDpr",
      "uRotX",
      "uRotY",
      "uSceneScale",
      "uCx",
      "uCy",
      "uDist",
      "uIsFar",
      "uFocusNodeIndex",
      "uHoverNodeIndex",
      "uLobeMul[0]"
    ]);

    this.edgeProgram = {
      program,
      vertexBuffer,
      indexBuffer,
      vao,
      uniforms,
      buf,
      centerline,
      edgeCount,
      meanZ: new Float32Array(edgeCount),
      sortScratch: new Int32Array(edgeCount),
      indexScratch: new Uint32Array(buf.indices.length),
      // node-buffer-index → incident edge vertex ranges, built once so a drag
      // touches only the dragged node's incident edges (not all edges).
      incidentMap: incidentEdgeRanges(graph, buf.edgeRanges),
      bufIndexToNode: graph.nodes.filter((node) => !!node._3dLobe),
      posBlockScratch: computeEdgePositionBlock({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
      edgeUploadScratch: new Float32Array(VERTS_PER_EDGE * EDGE_FLOATS_PER_VERT)
    };
    this.edgeGraph = graph;
    return this.edgeProgram;
  }

  /**
   * Draw the edge ribbon pass for one hemisphere.
   *
   * hemisphere = +1 draws far edges (mean projected z > 0); -1 draws near edges
   * (mean z <= 0). Each frame the CPU computes each edge's mean z (project the 13
   * sample points' z-component only — pure arithmetic, no allocation), partitions
   * far/near, stably sorts each group by mean z DESCENDING (tiebreak = dense edge
   * index, matching Canvas2D's stable sort over edges in graph order), then uploads
   * the sorted global element indices and issues ONE indexed draw.
   *
   * Blend: source-over premultiplied (ONE, ONE_MINUS_SRC_ALPHA). Edges are
   * translucent, so the (sorted) draw order is reproduced exactly.
   */
  private drawEdges(
    gl: WebGL2RenderingContext,
    graph: BrainGraph,
    proj: ProjectionOpts,
    hemisphere: 1 | -1,
    lobeMul: Float32Array,
    focusIdx: number,
    hoverIdx: number
  ): void {
    const ep = this.ensureEdgeProgram(gl, graph);
    if (ep.edgeCount === 0) return;

    // ---- CPU mean-z (z-only projection; no per-point allocation) ----
    const cosY = Math.cos(proj.rotY);
    const sinY = Math.sin(proj.rotY);
    const cosX = Math.cos(proj.rotX);
    const sinX = Math.sin(proj.rotX);
    const cl = ep.centerline;
    const meanZ = ep.meanZ;
    for (let e = 0; e < ep.edgeCount; e++) {
      let zSum = 0;
      const base = e * 13 * 3;
      for (let j = 0; j < 13; j++) {
        const c = base + j * 3;
        const x = cl[c + 0];
        const y = cl[c + 1];
        const z = cl[c + 2];
        const z1 = -x * sinY + z * cosY;
        const z2 = y * sinX + z1 * cosX;
        zSum += z2;
      }
      meanZ[e] = zSum / 13;
    }

    // ---- Partition + stable sort (descending mean z, tiebreak dense index) ----
    const wantFar = hemisphere > 0;
    const sort = ep.sortScratch;
    let n = 0;
    for (let e = 0; e < ep.edgeCount; e++) {
      const isFar = meanZ[e] > 0;
      if (isFar === wantFar) sort[n++] = e;
    }
    if (n === 0) return;
    // sortScratch[0..n) holds dense edge indices in graph order (ascending).
    // Sort DESCENDING by meanZ; ties keep ascending index order (JS sort is stable).
    const slice = sort.subarray(0, n);
    // Array.prototype.sort on a typed-array subarray is stable in V8; tiebreak is
    // the existing ascending order, matching Canvas2D's stable .sort((a,b)=>b.z-a.z).
    slice.sort((a, b) => meanZ[b] - meanZ[a]);

    // ---- Build sorted global element-index order, upload ----
    const indices = ep.buf.indices;
    const scratch = ep.indexScratch;
    let o = 0;
    for (let i = 0; i < n; i++) {
      const e = slice[i];
      const ib = e * INDICES_PER_EDGE;
      for (let k = 0; k < INDICES_PER_EDGE; k++) {
        scratch[o++] = indices[ib + k];
      }
    }
    const count = o; // number of indices to draw

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(ep.program);
    gl.bindVertexArray(ep.vao);

    // Upload the sorted index slice (count uint32s) into the dynamic element buffer.
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ep.indexBuffer);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, scratch, 0, count);

    const wDpr = Math.floor(this.width * this.dpr);
    const hDpr = Math.floor(this.height * this.dpr);
    gl.uniform2f(ep.uniforms.uResolution, wDpr, hDpr);
    gl.uniform1f(ep.uniforms.uDpr, this.dpr);
    gl.uniform1f(ep.uniforms.uRotX, proj.rotX);
    gl.uniform1f(ep.uniforms.uRotY, proj.rotY);
    gl.uniform1f(ep.uniforms.uSceneScale, proj.scale);
    gl.uniform1f(ep.uniforms.uCx, proj.cx);
    gl.uniform1f(ep.uniforms.uCy, proj.cy);
    gl.uniform1f(ep.uniforms.uDist, proj.dist);
    gl.uniform1f(ep.uniforms.uIsFar, wantFar ? 1 : 0);
    gl.uniform1f(ep.uniforms.uFocusNodeIndex, focusIdx);
    gl.uniform1f(ep.uniforms.uHoverNodeIndex, hoverIdx);
    gl.uniform1fv(ep.uniforms["uLobeMul[0]"], lobeMul);

    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0);

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  /**
   * Lazily build the node sprite program + static VBO + dynamic element buffer.
   * Rebuilds when the graph identity changes.
   *
   * Each _3dLobe node is expanded into a screen-space QUAD (6 vertices) carrying
   * its model xyz, base radius, hub flag, status code, lobe index, color, node
   * index, and a [-1,1]² corner offset. The vertex shader projects + sizes the
   * quad (bounding the node's full extent) and the fragment shader composites the
   * node's layers (halo/core/dot/[ring/crosshair]) in-fragment (see NODE_FS).
   *
   * The element buffer is DYNAMIC: drawNodes re-uploads a sorted slice of global
   * indices each frame so one indexed draw renders a whole hemisphere back-to-front.
   */
  private ensureNodeProgram(gl: WebGL2RenderingContext, graph: BrainGraph): NodeProgram {
    if (this.nodeProgram && this.nodeGraph === graph) return this.nodeProgram;

    if (this.nodeProgram) {
      gl.deleteVertexArray(this.nodeProgram.vao);
      gl.deleteBuffer(this.nodeProgram.vertexBuffer);
      gl.deleteBuffer(this.nodeProgram.indexBuffer);
      gl.deleteProgram(this.nodeProgram.program);
      this.nodeProgram = null;
    }

    const program = createProgram(gl, NODE_VS, NODE_FS);
    const buf = buildNodeBuffer(graph.nodes);
    const nodeCount = buf.count;

    // Interleaved layout (floats per vertex):
    //   pos(3) radiusBase(1) hub(1) status(1) lobeIndex(1)
    //   color(3) nodeIndex(1) corner(2) = 13 floats.
    const F = 13;
    const VERTS_PER_NODE = 6;
    // Corner offsets matching the cloud/bg/haze quad winding (two triangles).
    // Shared with the partial node-drag update (NODE_CORNERS) so the rewritten
    // block winding can never diverge from the build.
    const corners = NODE_CORNERS;
    const vertexCount = nodeCount * VERTS_PER_NODE;
    const data = new Float32Array(vertexCount * F);
    let o = 0;
    for (let i = 0; i < nodeCount; i++) {
      const x = buf.positions[i * 3 + 0];
      const y = buf.positions[i * 3 + 1];
      const z = buf.positions[i * 3 + 2];
      const r = buf.radius[i];
      const hub = buf.hub[i];
      const status = buf.status[i];
      const lobe = buf.lobeIndex[i];
      const cr = buf.color[i * 3 + 0];
      const cg = buf.color[i * 3 + 1];
      const cb = buf.color[i * 3 + 2];
      const nIdx = buf.nodeIndex[i];
      for (let c = 0; c < VERTS_PER_NODE; c++) {
        data[o++] = x;
        data[o++] = y;
        data[o++] = z;
        data[o++] = r;
        data[o++] = hub;
        data[o++] = status;
        data[o++] = lobe;
        data[o++] = cr;
        data[o++] = cg;
        data[o++] = cb;
        data[o++] = nIdx;
        data[o++] = corners[c][0];
        data[o++] = corners[c][1];
      }
    }
    const vertexBuffer = createStaticBuffer(gl, data);

    // Cache per-node model centers for fast per-frame z-only projection.
    const centers = new Float32Array(nodeCount * 3);
    centers.set(buf.positions.subarray(0, nodeCount * 3));

    // Static element-index template: 6 indices per node quad (two triangles).
    // Local 0-5; the renderer offsets by node*6 to make them global.
    const baseIndices = new Uint32Array(nodeCount * 6);
    for (let i = 0; i < nodeCount; i++) {
      const v = i * VERTS_PER_NODE;
      const ib = i * 6;
      // Two triangles: (0,1,3) (3,1,5)? Use the quad corner winding above:
      // verts 0,1,2 = tri A; verts 3,4,5 = tri B (matches the corners[] order).
      baseIndices[ib + 0] = v + 0;
      baseIndices[ib + 1] = v + 1;
      baseIndices[ib + 2] = v + 2;
      baseIndices[ib + 3] = v + 3;
      baseIndices[ib + 4] = v + 4;
      baseIndices[ib + 5] = v + 5;
    }

    const indexBuffer = gl.createBuffer();
    if (!indexBuffer) throw new Error("Brain Atlas: failed to create node index buffer.");
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, baseIndices.byteLength, gl.DYNAMIC_DRAW);

    const stride = F * 4;
    const loc = (name: string) => gl.getAttribLocation(program, name);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("Brain Atlas: failed to create node VAO.");
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    const fattr = (name: string, size: number, offsetFloats: number) => {
      const l = loc(name);
      if (l < 0) return;
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, gl.FLOAT, false, stride, offsetFloats * 4);
    };
    fattr("aPosition", 3, 0);
    fattr("aRadiusBase", 1, 3);
    fattr("aHub", 1, 4);
    fattr("aStatus", 1, 5);
    fattr("aLobeIndex", 1, 6);
    fattr("aColor", 3, 7);
    fattr("aNodeIndex", 1, 10);
    fattr("aCorner", 2, 11);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bindVertexArray(null);

    const uniforms = getUniformLocations(gl, program, [
      "uResolution",
      "uDpr",
      "uRotX",
      "uRotY",
      "uSceneScale",
      "uCx",
      "uCy",
      "uDist",
      "uHemisphere",
      "uHalo",
      "uBloom",
      "uFocusNodeIndex",
      "uHoverNodeIndex",
      "uLobeMul[0]"
    ]);

    this.nodeProgram = {
      program,
      vertexBuffer,
      indexBuffer,
      vao,
      uniforms,
      buf,
      centers,
      nodeCount,
      projZ: new Float32Array(nodeCount),
      sortScratch: new Int32Array(nodeCount),
      baseIndices,
      indexScratch: new Uint32Array(nodeCount * 6)
    };
    this.nodeGraph = graph;
    return this.nodeProgram;
  }

  /**
   * Draw the node sprite pass for one hemisphere.
   *
   * hemisphere = +1 draws far nodes (projected z > 0); -1 draws near nodes (z <= 0).
   * Each frame the CPU projects each node's single center z (pure arithmetic, no
   * allocation), partitions far/near, stably sorts each group by z DESCENDING
   * (tiebreak = node index, matching Canvas2D's stable sort over nodeProjs in
   * graph order), then uploads the sorted 6-index quad blocks and issues ONE
   * indexed draw. The vertex shader also re-checks far-ness and culls quads whose
   * far-ness != the requested pass (defense-in-depth; the CPU partition already
   * excludes them), plus the alpha<0.05 cull.
   *
   * Blend: source-over premultiplied (ONE, ONE_MINUS_SRC_ALPHA). Each node's layer
   * stack is composited in-fragment, then blended onto the framebuffer.
   */
  private drawNodes(
    gl: WebGL2RenderingContext,
    graph: BrainGraph,
    proj: ProjectionOpts,
    hemisphere: 1 | -1,
    lobeMul: Float32Array,
    focusIdx: number,
    hoverIdx: number
  ): void {
    const np = this.ensureNodeProgram(gl, graph);
    if (np.nodeCount === 0) return;

    // ---- CPU z-only projection per node (no per-node allocation) ----
    const cosY = Math.cos(proj.rotY);
    const sinY = Math.sin(proj.rotY);
    const cosX = Math.cos(proj.rotX);
    const sinX = Math.sin(proj.rotX);
    const ce = np.centers;
    const projZ = np.projZ;
    for (let i = 0; i < np.nodeCount; i++) {
      const x = ce[i * 3 + 0];
      const y = ce[i * 3 + 1];
      const z = ce[i * 3 + 2];
      const z1 = -x * sinY + z * cosY;
      const z2 = y * sinX + z1 * cosX;
      projZ[i] = z2;
    }

    // ---- Partition + stable sort (descending z, tiebreak node index) ----
    const wantFar = hemisphere > 0;
    const sort = np.sortScratch;
    let n = 0;
    for (let i = 0; i < np.nodeCount; i++) {
      const isFar = projZ[i] > 0;
      if (isFar === wantFar) sort[n++] = i;
    }
    if (n === 0) return;
    const slice = sort.subarray(0, n);
    // JS sort is stable in V8; ties keep ascending node index (matches Canvas2D's
    // stable .sort((a,b)=>b.z-a.z) over nodeProjs in graph order).
    slice.sort((a, b) => projZ[b] - projZ[a]);

    // ---- Build sorted global element-index order (6 per node), upload ----
    const baseIndices = np.baseIndices;
    const scratch = np.indexScratch;
    let o = 0;
    for (let i = 0; i < n; i++) {
      const node = slice[i];
      const ib = node * 6;
      for (let k = 0; k < 6; k++) {
        scratch[o++] = baseIndices[ib + k];
      }
    }
    const count = o;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(np.program);
    gl.bindVertexArray(np.vao);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, np.indexBuffer);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, scratch, 0, count);

    const wDpr = Math.floor(this.width * this.dpr);
    const hDpr = Math.floor(this.height * this.dpr);
    gl.uniform2f(np.uniforms.uResolution, wDpr, hDpr);
    gl.uniform1f(np.uniforms.uDpr, this.dpr);
    gl.uniform1f(np.uniforms.uRotX, proj.rotX);
    gl.uniform1f(np.uniforms.uRotY, proj.rotY);
    gl.uniform1f(np.uniforms.uSceneScale, proj.scale);
    gl.uniform1f(np.uniforms.uCx, proj.cx);
    gl.uniform1f(np.uniforms.uCy, proj.cy);
    gl.uniform1f(np.uniforms.uDist, proj.dist);
    gl.uniform1f(np.uniforms.uHemisphere, wantFar ? 1 : -1);
    gl.uniform1f(np.uniforms.uHalo, graph.CHAOS.halo);
    gl.uniform1f(np.uniforms.uBloom, graph.CHAOS.bloom);
    gl.uniform1f(np.uniforms.uFocusNodeIndex, focusIdx);
    gl.uniform1f(np.uniforms.uHoverNodeIndex, hoverIdx);
    gl.uniform1fv(np.uniforms["uLobeMul[0]"], lobeMul);

    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0);

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  /**
   * Lazily create + return the signal sprite program.
   *
   * The signal VBO is DYNAMIC: rebuilt each frame in drawSignals via bufferSubData.
   * We pre-allocate a buffer sized for MAX_SIGNAL_SPRITES sprites to avoid
   * reallocation. The CPU scratch Float32Array is kept on the program object.
   *
   * Vertex layout (9 floats per vertex):
   *   aCenter(2), aCorner(2), aColor(3), aHaloAlpha(1), aCoreAlpha(1),
   *   aHaloRadiusDev(1), aCoreRadiusDev(1)  → 11 floats per vertex.
   * 6 verts per sprite (two triangles covering the bounding square).
   */
  private ensureSignalProgram(gl: WebGL2RenderingContext): SignalProgram {
    if (this.signalProgram) return this.signalProgram;

    const program = createProgram(gl, SIGNAL_VS, SIGNAL_FS);

    const FLOATS_PER_VERT = 11;
    const VERTS_PER_SPRITE = 6;
    const capacityFloats = MAX_SIGNAL_SPRITES * VERTS_PER_SPRITE * FLOATS_PER_VERT;
    const capacityBytes = capacityFloats * 4;

    const vertexBuffer = gl.createBuffer();
    if (!vertexBuffer) throw new Error("Brain Atlas: failed to create signal vertex buffer.");
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, capacityBytes, gl.DYNAMIC_DRAW);

    const stride = FLOATS_PER_VERT * 4;
    const loc = (name: string) => gl.getAttribLocation(program, name);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("Brain Atlas: failed to create signal VAO.");
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);

    const fattr = (name: string, size: number, offsetFloats: number) => {
      const l = loc(name);
      if (l < 0) return;
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, gl.FLOAT, false, stride, offsetFloats * 4);
    };
    fattr("aCenter", 2, 0);
    fattr("aCorner", 2, 2);
    fattr("aColor", 3, 4);
    fattr("aHaloAlpha", 1, 7);
    fattr("aCoreAlpha", 1, 8);
    fattr("aHaloRadiusDev", 1, 9);
    fattr("aCoreRadiusDev", 1, 10);
    gl.bindVertexArray(null);

    const uniforms = getUniformLocations(gl, program, ["uResolution", "uDpr"]);

    this.signalProgram = {
      program,
      vertexBuffer,
      vao,
      uniforms,
      scratch: new Float32Array(capacityFloats),
      capacityBytes
    };
    return this.signalProgram;
  }

  /**
   * Draw the signal particle trail pass.
   *
   * Each signal has 6 sub-sprites; all geometry + alpha is computed on the CPU
   * (signals are few: single-digit count × 6 = a handful of quads). Values are
   * packed into a dynamic VBO (bufferSubData), then drawn as TRIANGLES (two tris
   * per quad = 6 verts per sprite).
   *
   * Blend: additive (ONE, ONE) — matches Canvas2D "lighter".
   *
   * Reproduces drawSignals() in renderer.ts EXACTLY. Key formula mirror:
   *   ctrl  = (a._3dLobe + b._3dLobe) * 0.35
   *   t     = max(0, tNorm - index*0.035)
   *   point = quadratic Bézier(a._3dLobe, ctrl, b._3dLobe, t)
   *   color = lerpHex(colA, colB, t) — Math.round in 0-255 space (same helper)
   *   fade  = (1 - index/6) * envelope
   *   depth = max(0.3, 1 - pr.depth * 0.6)
   *   radius = (1.3 - index*0.15) * max(0.5, pr.scale)  (CSS px)
   *   haloAlpha = 0.22 * fade * depth * regionAlpha
   *   coreAlpha = 0.55 * fade * depth * regionAlpha
   */
  private drawSignals(
    gl: WebGL2RenderingContext,
    proj: ProjectionOpts,
    now: number
  ): void {
    if (this.signals.length === 0) return;

    const sp = this.ensureSignalProgram(gl);
    const scratch = sp.scratch;
    const FLOATS_PER_VERT = 11;
    const VERTS_PER_SPRITE = 6;

    // Corner offsets (two triangles, matching the standard quad winding).
    const corners: [number, number][] = [
      [-1, -1], [1, -1], [-1, 1],
      [-1, 1],  [1, -1], [1, 1]
    ];

    let spriteCount = 0;
    let o = 0; // float offset into scratch

    for (const signal of this.signals) {
      if (!signal.a._3dLobe || !signal.b._3dLobe) continue;

      const tNorm = (now - signal.born) / signal.dur;
      if (tNorm < 0 || tNorm > 1) continue;

      const envelope = Math.sin(tNorm * Math.PI);
      const regionAlpha = Math.max(
        lobeVisibilityMultiplier(signal.a._lobeName, this.options.enabledLobes, this.highlightLobe),
        lobeVisibilityMultiplier(signal.b._lobeName, this.options.enabledLobes, this.highlightLobe)
      );

      const aLobe = signal.a._3dLobe;
      const bLobe = signal.b._3dLobe;
      const ctrl: Vec3 = {
        x: (aLobe.x + bLobe.x) * 0.35,
        y: (aLobe.y + bLobe.y) * 0.35,
        z: (aLobe.z + bLobe.z) * 0.35
      };

      for (let index = 0; index < 6; index += 1) {
        if (spriteCount >= MAX_SIGNAL_SPRITES) break;

        const t = Math.max(0, tNorm - index * 0.035);
        const mt = 1 - t;
        const point: Vec3 = {
          x: mt * mt * aLobe.x + 2 * mt * t * ctrl.x + t * t * bLobe.x,
          y: mt * mt * aLobe.y + 2 * mt * t * ctrl.y + t * t * bLobe.y,
          z: mt * mt * aLobe.z + 2 * mt * t * ctrl.z + t * t * bLobe.z
        };
        const pr = projectPoint(proj, point);

        const [cr, cg, cb] = lerpHex(signal.colA, signal.colB, t);
        const fade = (1 - index / 6) * envelope;
        const depth = Math.max(0.3, 1 - pr.depth * 0.6);
        const radius = (1.3 - index * 0.15) * Math.max(0.5, pr.scale);

        const haloAlpha = 0.22 * fade * depth * regionAlpha;
        const coreAlpha = 0.55 * fade * depth * regionAlpha;
        const haloRadiusDev = radius * 3.2 * this.dpr;
        const coreRadiusDev = Math.max(0.6, radius) * this.dpr;

        // Emit 6 vertices for this sprite quad.
        for (let c = 0; c < VERTS_PER_SPRITE; c++) {
          scratch[o++] = pr.sx;           // aCenter.x (CSS px)
          scratch[o++] = pr.sy;           // aCenter.y (CSS px)
          scratch[o++] = corners[c][0];   // aCorner.x
          scratch[o++] = corners[c][1];   // aCorner.y
          scratch[o++] = cr;              // aColor.r
          scratch[o++] = cg;              // aColor.g
          scratch[o++] = cb;              // aColor.b
          scratch[o++] = haloAlpha;       // aHaloAlpha
          scratch[o++] = coreAlpha;       // aCoreAlpha
          scratch[o++] = haloRadiusDev;   // aHaloRadiusDev
          scratch[o++] = coreRadiusDev;   // aCoreRadiusDev
        }
        spriteCount += 1;
      }
    }

    if (spriteCount === 0) return;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.useProgram(sp.program);
    gl.bindVertexArray(sp.vao);

    // Upload the packed sprite data (just the filled portion).
    gl.bindBuffer(gl.ARRAY_BUFFER, sp.vertexBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, scratch, 0, spriteCount * VERTS_PER_SPRITE * FLOATS_PER_VERT);

    const wDpr = Math.floor(this.width * this.dpr);
    const hDpr = Math.floor(this.height * this.dpr);
    gl.uniform2f(sp.uniforms.uResolution, wDpr, hDpr);
    gl.uniform1f(sp.uniforms.uDpr, this.dpr);

    gl.drawArrays(gl.TRIANGLES, 0, spriteCount * VERTS_PER_SPRITE);

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

}
