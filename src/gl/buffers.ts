/**
 * Pure vertex-buffer builders for the WebGL2 renderer.
 * No WebGL context, no DOM. Importable under node --test.
 *
 * Returns plain TypedArrays + metadata. The actual gl.createBuffer/gl.bufferData
 * calls happen in the renderer (Task 6).
 *
 * ============================================================
 * ATTRIBUTE LAYOUT  (documented for shader tasks)
 * ============================================================
 *
 * EDGE RIBBON BUFFER
 * ------------------
 * Each edge with two valid _3dLobe endpoints produces VERTS_PER_EDGE = 26 vertices.
 * Centerline: 13 model-space points sampled at t = 0/12, 1/12, …, 12/12
 *             from the quadratic Bézier with control = (A+B)*0.35.
 * Triangle strip: each centerline point is duplicated into a "side=-1" and
 *                 "side=+1" vertex. The vertex shader extrudes along the
 *                 screen-space normal by (lineWidth/2 + aaMargin) * side,
 *                 enabling analytic AA in the fragment shader.
 *
 * Layout (per vertex, by array):
 *   positions    Float32Array  stride 3    model xyz
 *   sides        Float32Array  stride 1    extrusion side: -1 or +1
 *   colorA       Float32Array  stride 3    lobe A color [r,g,b] in [0,1]
 *   colorB       Float32Array  stride 3    lobe B color [r,g,b] in [0,1]
 *   focusColor   Float32Array  stride 3    edge.A.color [r,g,b] (focus-mode override)
 *   sameLobe     Uint8Array    stride 1    1=same lobe, 0=different lobes
 *   colorSelector Uint8Array   stride 1    0=use cA, 1=use cB (provoking-vertex corrected)
 *                                          WebGL2 uses LAST_VERTEX_CONVENTION: segment k's
 *                                          flat value comes from tIdx=k+1. So vertex at
 *                                          tIdx j stores the selector for segment j-1:
 *                                          intra-lobe: always 0
 *                                          inter-lobe: tIdx 0-6 → 0, tIdx 7-12 → 1
 *                                          (delivers cA for segs 0-5, cB for segs 6-11,
 *                                          reproducing t<0.5→cA, t>=0.5→cB from renderer.ts)
 *   segmentIndex Uint8Array    stride 1    flat per-segment index 0-11 (provoking-vertex
 *                                          corrected): vertex at tIdx j stores clamp(j-1,0,11)
 *                                          so segment k's provoking vertex (tIdx k+1) delivers k.
 *                                          Vertex tIdx 0 stores 0 (never the provoking vertex).
 *   nodeIdxA     Uint32Array   stride 1    index of endpoint A in node buffer
 *   nodeIdxB     Uint32Array   stride 1    index of endpoint B in node buffer
 *   lobeIdxA     Uint8Array    stride 1    lobe index 0-5 of endpoint A
 *   lobeIdxB     Uint8Array    stride 1    lobe index 0-5 of endpoint B
 *   edgeIndex    Uint32Array   stride 1    dense valid-edge index (0-based position among
 *                                          edges with both _3dLobe endpoints). Note:
 *                                          edgeRanges[].edgeIndex carries the original
 *                                          graph.edges index; this attribute is the dense index.
 *
 * Vertex ordering within one edge (for triangle-strip drawing):
 *   tIdx=0 side=-1,  tIdx=0 side=+1,
 *   tIdx=1 side=-1,  tIdx=1 side=+1,
 *   …
 *   tIdx=12 side=-1, tIdx=12 side=+1
 *   → draw with gl.drawArrays(gl.TRIANGLE_STRIP, start, 26) per edge
 *     (with gl.PRIMITIVE_RESTART or separate draw calls between edges)
 *
 * segmentIndex for vertex at tIdx: clamp(tIdx-1, 0, 11)  [provoking-vertex corrected]
 *   Segment k is drawn from tIdx k and k+1; its provoking vertex is tIdx k+1, which stores k.
 *
 * CLOUD BUFFER
 * ------------
 *   positions  Float32Array  stride 3    model xyz
 *   lobeIndex  Uint8Array    stride 1    lobe index 0-5
 *   phase      Float32Array  stride 1    twinkle phase (twPhase)
 *   freq       Float32Array  stride 1    twinkle frequency (twFreq)
 *
 * NODE BUFFER
 * -----------
 *   positions  Float32Array  stride 3    model xyz (from _3dLobe)
 *   radius     Float32Array  stride 1    base nodeRadius (hub?6.5:2.6+min(3.4,deg*0.42))
 *   hub        Uint8Array    stride 1    1=hub, 0=non-hub
 *   status     Uint8Array    stride 1    0=active, 1=dormantRelevant, 2=archived
 *   lobeIndex  Uint8Array    stride 1    lobe index 0-5
 *   color      Float32Array  stride 3    node.color parsed as [r/255,g/255,b/255]
 *   nodeIndex  Uint32Array   stride 1    position of this node in the original nodes array
 *                                        (among nodes that have _3dLobe, 0-based)
 *
 * DONE_WITH_CONCERNS: The ribbon layout uses separate parallel TypedArrays rather than
 * interleaved buffers. Interleaved would be slightly more cache-friendly for the GPU but
 * requires knowing the final stride at build time. Separate arrays are easier to reason
 * about and upload independently (e.g. color-only rebuild without re-tessellating geometry).
 * The shader tasks should use glVertexAttribPointer with separate VBOs or restructure to
 * interleaved once the full attribute list is confirmed. See NOTE in edgeRanges output.
 * ============================================================
 */

import type { BrainGraph, BrainNode, LobeName } from "../types.ts";
import type { SurfacePoint } from "../shape.ts";
import { hexToRgb01 } from "./color.ts";

// ---- Constants ----

/** 13 Bézier sample points × 2 sides (triangle strip) = 26 vertices per edge. */
export const VERTS_PER_EDGE = 26;

/** Canonical lobe indices (0-5). These are the indices used in GPU buffers. */
export const LOBE_INDEX: Record<LobeName, number> = {
  frontal: 0,
  parietal: 1,
  temporal: 2,
  occipital: 3,
  cerebellum: 4,
  stem: 5
};

/**
 * LOBE_KIND: maps lobe name → palette.kinds key to look up the lobe color.
 * Matches render-core.ts LOBE_KIND and the spec's lobeColor definition.
 */
const LOBE_KIND: Record<LobeName, string> = {
  frontal: "project",
  parietal: "concept",
  temporal: "person",
  occipital: "source",
  cerebellum: "dailyNote",
  stem: "index"
};

// ---- Types ----

/** A vertex range within the edge ribbon buffer. */
export interface VertexRange {
  /** Start vertex index (inclusive). */
  start: number;
  /** Number of vertices. */
  count: number;
}

/** Range metadata for one edge. */
export interface EdgeRange extends VertexRange {
  /** Which edge in graph.edges (0-based). */
  edgeIndex: number;
}

/** Output of buildEdgeRibbons. */
export interface EdgeRibbonBuffer {
  /** Model-space xyz per vertex. Length = vertexCount * 3. */
  positions: Float32Array;
  /** Extrusion side: -1 or +1. Length = vertexCount. */
  sides: Float32Array;
  /** Lobe A RGB per vertex. Length = vertexCount * 3. */
  colorA: Float32Array;
  /** Lobe B RGB per vertex. Length = vertexCount * 3. */
  colorB: Float32Array;
  /** Focus-override color (edge.A.color) RGB per vertex. Length = vertexCount * 3. */
  focusColor: Float32Array;
  /** 1=same lobe, 0=inter-lobe. Length = vertexCount. */
  sameLobe: Uint8Array;
  /**
   * Color selector: 0=use cA, 1=use cB. Length = vertexCount. Provoking-vertex corrected.
   * WebGL2 LAST_VERTEX_CONVENTION: segment k's flat value comes from tIdx=k+1.
   * Vertex at tIdx j stores selector for segment j-1:
   *   intra-lobe: always 0.
   *   inter-lobe: tIdx 0-6 → 0 (cA), tIdx 7-12 → 1 (cB).
   * Delivers: segs 0-5 → cA, segs 6-11 → cB. Reproduces renderer.ts `t < 0.5 ? cA : cB`.
   */
  colorSelector: Uint8Array;
  /**
   * Flat per-segment index 0-11. Length = vertexCount. Provoking-vertex corrected.
   * Vertex at tIdx j stores clamp(j-1, 0, 11) so segment k's provoking vertex (tIdx k+1)
   * delivers segIdx=k. Shader code reading this as `flat` must rely on the provoking vertex.
   */
  segmentIndex: Uint8Array;
  /** Node-buffer index of endpoint A. Length = vertexCount. */
  nodeIdxA: Uint32Array;
  /** Node-buffer index of endpoint B. Length = vertexCount. */
  nodeIdxB: Uint32Array;
  /** Lobe index 0-5 of endpoint A. Length = vertexCount. */
  lobeIdxA: Uint8Array;
  /** Lobe index 0-5 of endpoint B. Length = vertexCount. */
  lobeIdxB: Uint8Array;
  /**
   * Dense valid-edge index (0-based position among edges with both _3dLobe endpoints).
   * Length = vertexCount. Note: edgeRanges[].edgeIndex carries the original graph.edges
   * index; this attribute is the dense index used for per-draw-call lookups.
   */
  edgeIndex: Uint32Array;
  /** Total vertex count across all edges. */
  vertexCount: number;
  /** Per-edge vertex range metadata. */
  edgeRanges: EdgeRange[];
}

/** Output of buildCloudBuffer. */
export interface CloudBuffer {
  /** Model xyz per point. Length = count * 3. */
  positions: Float32Array;
  /** Lobe index 0-5 per point. Length = count. */
  lobeIndex: Uint8Array;
  /** Twinkle phase per point. Length = count. */
  phase: Float32Array;
  /** Twinkle frequency per point. Length = count. */
  freq: Float32Array;
  /** Number of cloud points. */
  count: number;
}

/** Output of buildNodeBuffer. */
export interface NodeBuffer {
  /** Model xyz per node. Length = count * 3. */
  positions: Float32Array;
  /** Base nodeRadius per node. Length = count. */
  radius: Float32Array;
  /** Hub flag (0/1) per node. Length = count. */
  hub: Uint8Array;
  /** Status (0=active, 1=dormantRelevant, 2=archived) per node. Length = count. */
  status: Uint8Array;
  /** Lobe index 0-5 per node. Length = count. */
  lobeIndex: Uint8Array;
  /** Node color [r,g,b] per node. Length = count * 3. */
  color: Float32Array;
  /** Original node index (among _3dLobe nodes) per node. Length = count. */
  nodeIndex: Uint32Array;
  /** Number of nodes in the buffer. */
  count: number;
}

// ---- Helpers ----

function lobeColor(lobe: LobeName, graph: BrainGraph): [number, number, number] {
  const kindKey = LOBE_KIND[lobe];
  const hex = graph.activePalette.kinds[kindKey] ?? graph.activePalette.hud;
  return hexToRgb01(hex);
}

function nodeRadius(node: BrainNode): number {
  if (node.hub) return 6.5;
  return 2.6 + Math.min(3.4, (node.degree || 0) * 0.42);
}

function statusCode(status: BrainNode["status"]): number {
  if (status === "dormantRelevant") return 1;
  if (status === "archived") return 2;
  return 0; // "active"
}

// ---- buildEdgeRibbons ----

/**
 * Build the edge ribbon vertex buffer from a graph.
 *
 * Skips edges where either endpoint lacks _3dLobe (matching renderer.ts).
 * Samples each valid edge's quadratic Bézier at 13 points (t = i/12, i=0..12),
 * control point = (A._3dLobe + B._3dLobe) * 0.35.
 * Each sample point becomes 2 vertices (side=-1, side=+1).
 *
 * Node buffer index is the position of a node among graph.nodes nodes
 * that have _3dLobe (same ordering as buildNodeBuffer).
 */
export function buildEdgeRibbons(graph: BrainGraph): EdgeRibbonBuffer {
  const SAMPLES = 12; // 12 segments → 13 points (matching renderer.ts `const samples = 12`)
  const POINTS = SAMPLES + 1;   // 13
  const SIDES = 2;              // -1, +1
  const VERTS = POINTS * SIDES; // 26 = VERTS_PER_EDGE

  // Pre-build node buffer index map: node id → index among _3dLobe nodes
  const nodeBufferIdx = new Map<string, number>();
  let nbIdx = 0;
  for (const node of graph.nodes) {
    if (node._3dLobe) {
      nodeBufferIdx.set(node.id, nbIdx++);
    }
  }

  // Count valid edges upfront to allocate correctly
  const validEdges: Array<{ edgeIdx: number; A: BrainNode; B: BrainNode }> = [];
  for (let ei = 0; ei < graph.edges.length; ei++) {
    const edge = graph.edges[ei];
    const A = graph.idx[edge.a];
    const B = graph.idx[edge.b];
    if (!A?._3dLobe || !B?._3dLobe) continue;
    validEdges.push({ edgeIdx: ei, A, B });
  }

  const totalVerts = validEdges.length * VERTS;

  // Allocate all arrays
  const positions    = new Float32Array(totalVerts * 3);
  const sides        = new Float32Array(totalVerts);
  const colorA       = new Float32Array(totalVerts * 3);
  const colorB       = new Float32Array(totalVerts * 3);
  const focusColor   = new Float32Array(totalVerts * 3);
  const sameLobe     = new Uint8Array(totalVerts);
  const colorSelector = new Uint8Array(totalVerts);
  const segmentIndex  = new Uint8Array(totalVerts);
  const nodeIdxA     = new Uint32Array(totalVerts);
  const nodeIdxB     = new Uint32Array(totalVerts);
  const lobeIdxA     = new Uint8Array(totalVerts);
  const lobeIdxB     = new Uint8Array(totalVerts);
  const edgeIndexArr = new Uint32Array(totalVerts);

  const edgeRanges: EdgeRange[] = [];
  let vBase = 0; // vertex offset for the current edge

  for (let vi = 0; vi < validEdges.length; vi++) {
    const { edgeIdx, A, B } = validEdges[vi];
    const aLobe = (A._lobeName ?? "parietal") as LobeName;
    const bLobe = (B._lobeName ?? "parietal") as LobeName;
    const sameLobeVal = aLobe === bLobe ? 1 : 0;

    const cA = lobeColor(aLobe, graph);
    const cB = lobeColor(bLobe, graph);
    const fC = hexToRgb01(A.color); // focus override = edge.A.color

    const lobeA = LOBE_INDEX[aLobe] ?? 0;
    const lobeB = LOBE_INDEX[bLobe] ?? 0;

    const nIdxA = nodeBufferIdx.get(A.id) ?? 0;
    const nIdxB = nodeBufferIdx.get(B.id) ?? 0;

    const ctrl = {
      x: (A._3dLobe!.x + B._3dLobe!.x) * 0.35,
      y: (A._3dLobe!.y + B._3dLobe!.y) * 0.35,
      z: (A._3dLobe!.z + B._3dLobe!.z) * 0.35
    };

    // Sample the Bézier at POINTS = 13 values of t
    for (let tIdx = 0; tIdx < POINTS; tIdx++) {
      const t = tIdx / SAMPLES;
      const mt = 1 - t;
      const px = mt * mt * A._3dLobe!.x + 2 * mt * t * ctrl.x + t * t * B._3dLobe!.x;
      const py = mt * mt * A._3dLobe!.y + 2 * mt * t * ctrl.y + t * t * B._3dLobe!.y;
      const pz = mt * mt * A._3dLobe!.z + 2 * mt * t * ctrl.z + t * t * B._3dLobe!.z;

      // PROVOKING-VERTEX CONVENTION (WebGL2 fixed at LAST_VERTEX_CONVENTION):
      // In a TRIANGLE_STRIP, segment k (between tIdx k and k+1) is drawn by two triangles
      // whose last (provoking) vertices are both at tIdx = k+1. A `flat` attribute for
      // segment k is therefore delivered from the vertex stored at tIdx = k+1.
      //
      // So the value stored at vertex tIdx j must be the value SEGMENT j-1 needs.
      // Vertex tIdx 0 is never a provoking vertex; its stored value is unused.
      //
      // segmentIndex: segment k's provoking vertex (tIdx k+1) must carry segIdx = k.
      //   → vertex at tIdx j stores: clamp(j - 1, 0, 11)
      //   (tIdx 0 stores 0; it's unused as a provoking vertex — clamping to 0 is fine.)
      const segIdx = Math.max(0, Math.min(tIdx - 1, SAMPLES - 1));

      // colorSelector: 0=cA, 1=cB.
      // Intra-lobe: always 0.
      // Inter-lobe (provoking-vertex corrected):
      //   Segment k needs cB iff k >= 6. The provoking vertex for segment k is at tIdx = k+1.
      //   So vertex at tIdx j stores 1 iff (j-1) >= 6, i.e. j > 6.
      //   → tIdx 0..6 → 0 (cA), tIdx 7..12 → 1 (cB).
      //   This reproduces `t < 0.5 ? cA : cB` from renderer.ts (Canvas2D reference)
      //   under the GPU's last-vertex provoking convention.
      const selector = (sameLobeVal === 0 && tIdx > 6) ? 1 : 0;

      // Emit two vertices: side=-1 and side=+1
      for (let s = 0; s < SIDES; s++) {
        const side = s === 0 ? -1 : 1;
        const v = vBase + tIdx * SIDES + s;

        positions[v * 3 + 0] = px;
        positions[v * 3 + 1] = py;
        positions[v * 3 + 2] = pz;

        sides[v] = side;

        colorA[v * 3 + 0] = cA[0];
        colorA[v * 3 + 1] = cA[1];
        colorA[v * 3 + 2] = cA[2];

        colorB[v * 3 + 0] = cB[0];
        colorB[v * 3 + 1] = cB[1];
        colorB[v * 3 + 2] = cB[2];

        focusColor[v * 3 + 0] = fC[0];
        focusColor[v * 3 + 1] = fC[1];
        focusColor[v * 3 + 2] = fC[2];

        sameLobe[v] = sameLobeVal;
        colorSelector[v] = selector;
        segmentIndex[v] = segIdx;

        nodeIdxA[v] = nIdxA;
        nodeIdxB[v] = nIdxB;
        lobeIdxA[v] = lobeA;
        lobeIdxB[v] = lobeB;
        edgeIndexArr[v] = vi; // dense edge index (only valid edges)
      }
    }

    edgeRanges.push({ edgeIndex: edgeIdx, start: vBase, count: VERTS });
    vBase += VERTS;
  }

  return {
    positions,
    sides,
    colorA,
    colorB,
    focusColor,
    sameLobe,
    colorSelector,
    segmentIndex,
    nodeIdxA,
    nodeIdxB,
    lobeIdxA,
    lobeIdxB,
    edgeIndex: edgeIndexArr,
    vertexCount: totalVerts,
    edgeRanges
  };
}

// ---- buildCloudBuffer ----

/**
 * Build the cloud point vertex buffer from an array of SurfacePoints.
 * Each point stores its model-space xyz, lobe index, and twinkle phase/freq.
 * The `far` (z > 0) classification happens per-frame in the shader (from projected z).
 */
export function buildCloudBuffer(cloud: SurfacePoint[]): CloudBuffer {
  const count = cloud.length;
  const positions = new Float32Array(count * 3);
  const lobeIndex = new Uint8Array(count);
  const phase = new Float32Array(count);
  const freq = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const p = cloud[i];
    positions[i * 3 + 0] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;

    const lobe = (p.lobe ?? "parietal") as LobeName;
    lobeIndex[i] = LOBE_INDEX[lobe] ?? 1;

    phase[i] = p.twPhase ?? 0;
    freq[i] = p.twFreq ?? 1;
  }

  return { positions, lobeIndex, phase, freq, count };
}

// ---- buildNodeBuffer ----

/**
 * Build the node vertex buffer from a node array.
 * Only includes nodes that have _3dLobe (matching renderer.ts filter).
 * nodeRadius formula: hub → 6.5; else 2.6 + min(3.4, degree * 0.42).
 * Status encoding: 0=active, 1=dormantRelevant, 2=archived.
 */
export function buildNodeBuffer(nodes: BrainNode[]): NodeBuffer {
  const valid = nodes.filter((n) => !!n._3dLobe);
  const count = valid.length;

  const positions = new Float32Array(count * 3);
  const radius    = new Float32Array(count);
  const hub       = new Uint8Array(count);
  const status    = new Uint8Array(count);
  const lobeIndex = new Uint8Array(count);
  const color     = new Float32Array(count * 3);
  const nodeIndex = new Uint32Array(count);

  for (let i = 0; i < count; i++) {
    const node = valid[i];
    const lobe = (node._lobeName ?? "parietal") as LobeName;

    positions[i * 3 + 0] = node._3dLobe!.x;
    positions[i * 3 + 1] = node._3dLobe!.y;
    positions[i * 3 + 2] = node._3dLobe!.z;

    radius[i] = nodeRadius(node);
    hub[i] = node.hub ? 1 : 0;
    status[i] = statusCode(node.status);
    lobeIndex[i] = LOBE_INDEX[lobe] ?? 1;

    const rgb = hexToRgb01(node.color);
    color[i * 3 + 0] = rgb[0];
    color[i * 3 + 1] = rgb[1];
    color[i * 3 + 2] = rgb[2];

    nodeIndex[i] = i;
  }

  return { positions, radius, hub, status, lobeIndex, color, nodeIndex, count };
}

// ---- incidentEdgeRanges ----

/**
 * Build a map from node-buffer-index → array of VertexRanges for all edges
 * incident to that node. Used for partial gl.bufferSubData on node drag.
 *
 * @param graph        The brain graph (provides edges and idx).
 * @param edgeRanges   The EdgeRange[] from buildEdgeRibbons (same graph).
 */
export function incidentEdgeRanges(
  graph: BrainGraph,
  edgeRanges: EdgeRange[]
): Map<number, VertexRange[]> {
  // Build node buffer index map first
  const nodeBufferIdx = new Map<string, number>();
  let nbIdx = 0;
  for (const node of graph.nodes) {
    if (node._3dLobe) {
      nodeBufferIdx.set(node.id, nbIdx++);
    }
  }

  const result = new Map<number, VertexRange[]>();

  // edgeRanges are produced only for valid (both endpoints have _3dLobe) edges,
  // but edgeRange.edgeIndex refers to the original graph.edges index.
  // We iterate edgeRanges (dense index vi = position in edgeRanges array).
  for (let vi = 0; vi < edgeRanges.length; vi++) {
    const range = edgeRanges[vi];
    const edge = graph.edges[range.edgeIndex];
    if (!edge) continue;

    const A = graph.idx[edge.a];
    const B = graph.idx[edge.b];
    if (!A?._3dLobe || !B?._3dLobe) continue;

    const idxA = nodeBufferIdx.get(A.id);
    const idxB = nodeBufferIdx.get(B.id);

    if (idxA !== undefined) {
      if (!result.has(idxA)) result.set(idxA, []);
      result.get(idxA)!.push({ start: range.start, count: range.count });
    }
    if (idxB !== undefined) {
      if (!result.has(idxB)) result.set(idxB, []);
      result.get(idxB)!.push({ start: range.start, count: range.count });
    }
  }

  return result;
}
