/**
 * Pure-function tests for src/gl/buffers.ts.
 * Uses a small hand-constructed graph (3 nodes, 2 edges: one intra-lobe,
 * one inter-lobe). No WebGL, no DOM, no Obsidian APIs.
 *
 * Buffer attribute layout under test (documented in buffers.ts):
 *
 * EDGE RIBBON — per centerline vertex (13 points × 2 sides = 26 verts/edge):
 *   positions:    Float32Array  [x,y,z per vertex]                     stride 3
 *   sides:        Float32Array  [side per vertex: -1 or +1]            stride 1
 *   colorA:       Float32Array  [r,g,b per vertex, from lobe A]        stride 3
 *   colorB:       Float32Array  [r,g,b per vertex, from lobe B]        stride 3
 *   focusColor:   Float32Array  [r,g,b per vertex, = edge.A.color]     stride 3
 *   sameLobe:     Uint8Array    [0 or 1 per vertex]                    stride 1
 *   segmentIndex: Uint8Array    [flat segment index 0-11 per vertex]   stride 1
 *   nodeIdxA:     Uint32Array   [node-buffer index of endpoint A]      stride 1
 *   nodeIdxB:     Uint32Array   [node-buffer index of endpoint B]      stride 1
 *   lobeIdxA:     Uint8Array    [lobe index 0-5 of endpoint A]         stride 1
 *   lobeIdxB:     Uint8Array    [lobe index 0-5 of endpoint B]         stride 1
 *   edgeIndex:    Uint32Array   [which edge (0-based) per vertex]      stride 1
 *
 * CLOUD BUFFER — per cloud point:
 *   positions:   Float32Array  [x,y,z]            stride 3
 *   lobeIndex:   Uint8Array    [lobe index 0-5]   stride 1
 *   phase:       Float32Array  [twPhase]           stride 1
 *   freq:        Float32Array  [twFreq]            stride 1
 *
 * NODE BUFFER — per node (those with _3dLobe):
 *   positions:   Float32Array  [x,y,z]            stride 3
 *   radius:      Float32Array  [nodeRadius base]  stride 1
 *   hub:         Uint8Array    [0 or 1]           stride 1
 *   status:      Uint8Array    [0=active,1=dormantRelevant,2=archived]  stride 1
 *   lobeIndex:   Uint8Array    [lobe index 0-5]   stride 1
 *   color:       Float32Array  [r,g,b]            stride 3
 *   nodeIndex:   Uint32Array   [original node index in nodes array]    stride 1
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEdgeRibbons,
  buildCloudBuffer,
  buildNodeBuffer,
  incidentEdgeRanges,
  LOBE_INDEX,
  VERTS_PER_EDGE
} from "../src/gl/buffers.ts";

// ---- Minimal test fixtures ----

const PALETTE = {
  label: "test",
  bg: "#000000",
  bgFar: "#000000",
  fg: "#ffffff",
  hud: "#aaaaaa",
  chroma: 1,
  kinds: {
    // frontal→project, parietal→concept, person→temporal (used via LOBE_KIND)
    project: "#ff0000",   // frontal lobe color
    concept: "#00ff00",   // parietal lobe color
    person: "#0000ff",    // temporal lobe color (unused in test edges, but present)
    source: "#ffff00",
    dailyNote: "#ff00ff",
    index: "#00ffff"
  }
};

// Nodes: A and B in frontal lobe, C in parietal lobe
const nodeA = {
  id: "A",
  name: "A",
  title: "A",
  kind: "project",
  kindLabel: "PROJECT",
  status: "active",
  hub: true,
  degree: 5,
  color: "#ff1234",
  path: "A.md",
  classificationSource: "default",
  _3dLobe: { x: 0.1, y: 0.2, z: 0.8 },
  _lobeName: "frontal"
};

const nodeB = {
  id: "B",
  name: "B",
  title: "B",
  kind: "project",
  kindLabel: "PROJECT",
  status: "dormantRelevant",
  hub: false,
  degree: 3,
  color: "#22aaff",
  path: "B.md",
  classificationSource: "default",
  _3dLobe: { x: 0.05, y: 0.3, z: 0.7 },
  _lobeName: "frontal"
};

const nodeC = {
  id: "C",
  name: "C",
  title: "C",
  kind: "concept",
  kindLabel: "CONCEPT",
  status: "archived",
  hub: false,
  degree: 1,
  color: "#55ff44",
  path: "C.md",
  classificationSource: "default",
  _3dLobe: { x: 0.0, y: 0.65, z: -0.1 },
  _lobeName: "parietal"
};

// Edge 0: intra-lobe (A–B, both frontal)
const edgeAB = { a: "A", b: "B" };
// Edge 1: inter-lobe (A–C, frontal→parietal)
const edgeAC = { a: "A", b: "C" };

const GRAPH = {
  nodes: [nodeA, nodeB, nodeC],
  edges: [edgeAB, edgeAC],
  idx: { A: nodeA, B: nodeB, C: nodeC },
  adj: { A: ["B", "C"], B: ["A"], C: ["A"] },
  KIND_LABEL: {},
  activePalette: PALETTE,
  activePaletteName: "test",
  CHAOS: { wobbleAmp: 0, wobbleSpeed: 0, halo: 1, bloom: 1, blob: 0, jitter: 0 }
};

// ---- Quadratic Bezier helper (reference implementation) ----
function bezier(A, ctrl, B, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * A.x + 2 * mt * t * ctrl.x + t * t * B.x,
    y: mt * mt * A.y + 2 * mt * t * ctrl.y + t * t * B.y,
    z: mt * mt * A.z + 2 * mt * t * ctrl.z + t * t * B.z
  };
}

// ---- Tests ----

test("VERTS_PER_EDGE is 26 (13 points × 2 sides)", () => {
  assert.equal(VERTS_PER_EDGE, 26);
});

test("buildEdgeRibbons: vertexCount equals edges × VERTS_PER_EDGE", () => {
  const result = buildEdgeRibbons(GRAPH);
  assert.equal(result.vertexCount, 2 * VERTS_PER_EDGE);
});

test("buildEdgeRibbons: edgeRanges has one entry per edge", () => {
  const result = buildEdgeRibbons(GRAPH);
  assert.equal(result.edgeRanges.length, 2);
});

test("buildEdgeRibbons: edgeRanges are contiguous and non-overlapping", () => {
  const result = buildEdgeRibbons(GRAPH);
  // Edge 0 starts at 0, edge 1 starts where edge 0 ends
  assert.equal(result.edgeRanges[0].start, 0);
  assert.equal(result.edgeRanges[0].count, VERTS_PER_EDGE);
  assert.equal(result.edgeRanges[1].start, VERTS_PER_EDGE);
  assert.equal(result.edgeRanges[1].count, VERTS_PER_EDGE);
});

test("buildEdgeRibbons: edgeRanges carry the correct edgeIndex", () => {
  const result = buildEdgeRibbons(GRAPH);
  assert.equal(result.edgeRanges[0].edgeIndex, 0);
  assert.equal(result.edgeRanges[1].edgeIndex, 1);
});

test("buildEdgeRibbons: control point is (A+B)*0.35 for edge A–B", () => {
  const result = buildEdgeRibbons(GRAPH);
  const A = nodeA._3dLobe;
  const B = nodeB._3dLobe;
  const expectedCtrl = {
    x: (A.x + B.x) * 0.35,
    y: (A.y + B.y) * 0.35,
    z: (A.z + B.z) * 0.35
  };
  // Float32Array has ~7 significant digits; use 1e-6 tolerance for stored values.
  const EPS = 1e-6;

  // t=0 → first point should be A
  // Vertex 0 in edge 0 is at offset 0 in positions, first of the "side=-1" duplicate
  const px0 = result.positions[0];
  const py0 = result.positions[1];
  const pz0 = result.positions[2];
  assert.ok(Math.abs(px0 - A.x) < EPS, `t=0 x: got ${px0}, expected ${A.x}`);
  assert.ok(Math.abs(py0 - A.y) < EPS, `t=0 y: got ${py0}, expected ${A.y}`);
  assert.ok(Math.abs(pz0 - A.z) < EPS, `t=0 z: got ${pz0}, expected ${A.z}`);

  // t=1 → point at centerline index 12 (second-to-last vertex group in edge 0)
  // positions are laid out: for each t index 0..12, we have 2 verts (side -1 and +1)
  // vertex at t=12 is at position offset 12*2*3 = 72 (float32)
  const t12Offset = 12 * 2 * 3;
  const px12 = result.positions[t12Offset];
  const py12 = result.positions[t12Offset + 1];
  const pz12 = result.positions[t12Offset + 2];
  assert.ok(Math.abs(px12 - B.x) < EPS, `t=1 x: got ${px12}, expected ${B.x}`);
  assert.ok(Math.abs(py12 - B.y) < EPS, `t=1 y: got ${py12}, expected ${B.y}`);
  assert.ok(Math.abs(pz12 - B.z) < EPS, `t=1 z: got ${pz12}, expected ${B.z}`);

  // t=0.5 → Bezier midpoint
  const mid = bezier(A, expectedCtrl, B, 0.5);
  const t6Offset = 6 * 2 * 3;
  const px6 = result.positions[t6Offset];
  const py6 = result.positions[t6Offset + 1];
  const pz6 = result.positions[t6Offset + 2];
  assert.ok(Math.abs(px6 - mid.x) < EPS, `t=0.5 x: got ${px6}, expected ${mid.x}`);
  assert.ok(Math.abs(py6 - mid.y) < EPS, `t=0.5 y: got ${py6}, expected ${mid.y}`);
  assert.ok(Math.abs(pz6 - mid.z) < EPS, `t=0.5 z: got ${pz6}, expected ${mid.z}`);
});

test("buildEdgeRibbons: intra-lobe edge has sameLobe=1 for all vertices", () => {
  const result = buildEdgeRibbons(GRAPH);
  // Edge 0 (A–B): intra-lobe. Vertices 0..VERTS_PER_EDGE-1.
  for (let v = 0; v < VERTS_PER_EDGE; v++) {
    assert.equal(result.sameLobe[v], 1, `vertex ${v} sameLobe should be 1`);
  }
});

test("buildEdgeRibbons: inter-lobe edge has sameLobe=0 for all vertices", () => {
  const result = buildEdgeRibbons(GRAPH);
  // Edge 1 (A–C): inter-lobe. Vertices VERTS_PER_EDGE..2*VERTS_PER_EDGE-1.
  for (let v = VERTS_PER_EDGE; v < 2 * VERTS_PER_EDGE; v++) {
    assert.equal(result.sameLobe[v], 0, `vertex ${v} sameLobe should be 0`);
  }
});

// ---- Provoking-vertex helper ----
// WebGL2 uses LAST_VERTEX_CONVENTION for `flat` attributes. In a TRIANGLE_STRIP with
// vertex layout: tIdx=0 side=-1, tIdx=0 side=+1, tIdx=1 side=-1, tIdx=1 side=+1, ...
// the two triangles forming segment k both have their provoking (last) vertex at tIdx=k+1.
// Therefore the GPU-delivered flat value for segment k comes from buffer vertices at tIdx=k+1,
// i.e. buffer indices 2*(k+1) and 2*(k+1)+1 within the edge's range (both sides must agree).
//
// deliveredFlatValue(attr, edgeStart, segmentK) returns the value the GPU would see for seg k.
function deliveredFlatValue(attr, edgeStart, segmentK) {
  const provokingTIdx = segmentK + 1;  // provoking vertex tIdx = k+1
  const vMinus = edgeStart + provokingTIdx * 2;      // side=-1 vertex
  const vPlus  = edgeStart + provokingTIdx * 2 + 1;  // side=+1 vertex
  assert.equal(
    attr[vMinus], attr[vPlus],
    `edge at ${edgeStart} seg${segmentK}: side=-1 and side=+1 provoking values must agree`
  );
  return attr[vMinus];
}

test("buildEdgeRibbons: per-segment color selector — intra-lobe: all 12 segments deliver cA (0)", () => {
  const result = buildEdgeRibbons(GRAPH);
  // Edge 0 is intra-lobe (frontal→frontal). colorSelector must always be 0.
  // We check via the provoking convention: for each segment k, the delivered value
  // (from the provoking vertex at tIdx=k+1) must be 0 (cA).
  for (let k = 0; k < 12; k++) {
    const delivered = deliveredFlatValue(result.colorSelector, 0, k);
    assert.equal(delivered, 0, `intra-lobe seg${k}: delivered colorSelector should be 0 (cA)`);
  }
});

test("buildEdgeRibbons: per-segment color selector — inter-lobe: segs 0-5 deliver cA, 6-11 deliver cB", () => {
  const result = buildEdgeRibbons(GRAPH);
  // Edge 1 (A–C): inter-lobe (frontal→parietal).
  // Canvas2D reference (renderer.ts line 197): `t < 0.5 ? cA : cB` where t = segmentIndex/12.
  // Segments 0-5: t = 0/12..5/12 < 0.5 → cA (colorSelector=0).
  // Segments 6-11: t = 6/12..11/12 >= 0.5 → cB (colorSelector=1).
  //
  // Under WebGL2 LAST_VERTEX_CONVENTION: the GPU reads the flat colorSelector for segment k
  // from the provoking vertex at tIdx=k+1. We model this with deliveredFlatValue.
  for (let k = 0; k < 12; k++) {
    const expectedSelector = k < 6 ? 0 : 1;
    const delivered = deliveredFlatValue(result.colorSelector, VERTS_PER_EDGE, k);
    assert.equal(
      delivered, expectedSelector,
      `inter-lobe seg${k}: delivered colorSelector should be ${expectedSelector} (${expectedSelector === 0 ? "cA" : "cB"})`
    );
  }
});

test("buildEdgeRibbons: colorA carries the lobe A RGB for all vertices of an edge", () => {
  const result = buildEdgeRibbons(GRAPH);
  // Edge 0 (A–B): lobe A = frontal → kinds.project = #ff0000 → [1,0,0]
  const expected = [1.0, 0.0, 0.0];
  const EPS = 1e-6;
  for (let v = 0; v < VERTS_PER_EDGE; v++) {
    assert.ok(Math.abs(result.colorA[v * 3 + 0] - expected[0]) < EPS, `v${v} cA.r`);
    assert.ok(Math.abs(result.colorA[v * 3 + 1] - expected[1]) < EPS, `v${v} cA.g`);
    assert.ok(Math.abs(result.colorA[v * 3 + 2] - expected[2]) < EPS, `v${v} cA.b`);
  }
});

test("buildEdgeRibbons: colorB carries the lobe B RGB for all vertices of an inter-lobe edge", () => {
  const result = buildEdgeRibbons(GRAPH);
  // Edge 1 (A–C): lobe B = parietal → kinds.concept = #00ff00 → [0,1,0]
  const expected = [0.0, 1.0, 0.0];
  const EPS = 1e-6;
  for (let v = VERTS_PER_EDGE; v < 2 * VERTS_PER_EDGE; v++) {
    assert.ok(Math.abs(result.colorB[v * 3 + 0] - expected[0]) < EPS, `v${v} cB.r`);
    assert.ok(Math.abs(result.colorB[v * 3 + 1] - expected[1]) < EPS, `v${v} cB.g`);
    assert.ok(Math.abs(result.colorB[v * 3 + 2] - expected[2]) < EPS, `v${v} cB.b`);
  }
});

test("buildEdgeRibbons: focusColor carries edge.A.color (node color, not lobe color)", () => {
  const result = buildEdgeRibbons(GRAPH);
  // Edge 0: A.color = #ff1234 → [0xff/255, 0x12/255, 0x34/255]
  const expected = [0xff / 255, 0x12 / 255, 0x34 / 255];
  const EPS = 1e-6;
  for (let v = 0; v < VERTS_PER_EDGE; v++) {
    assert.ok(Math.abs(result.focusColor[v * 3 + 0] - expected[0]) < EPS, `v${v} focusColor.r`);
    assert.ok(Math.abs(result.focusColor[v * 3 + 1] - expected[1]) < EPS, `v${v} focusColor.g`);
    assert.ok(Math.abs(result.focusColor[v * 3 + 2] - expected[2]) < EPS, `v${v} focusColor.b`);
  }
});

test("buildEdgeRibbons: sides alternate -1/+1 within each t-step", () => {
  const result = buildEdgeRibbons(GRAPH);
  for (let tIdx = 0; tIdx <= 12; tIdx++) {
    const v0 = tIdx * 2;
    const v1 = tIdx * 2 + 1;
    assert.equal(result.sides[v0], -1, `tIdx=${tIdx} side0=-1`);
    assert.equal(result.sides[v1], 1, `tIdx=${tIdx} side1=+1`);
  }
});

test("buildEdgeRibbons: nodeIdxA and nodeIdxB carry correct node buffer indices", () => {
  const result = buildEdgeRibbons(GRAPH);
  // Node buffer index: nodeA=0, nodeB=1, nodeC=2 (all have _3dLobe)
  // Edge 0 (A–B): nodeIdxA=0, nodeIdxB=1
  for (let v = 0; v < VERTS_PER_EDGE; v++) {
    assert.equal(result.nodeIdxA[v], 0, `edge0 v${v} nodeIdxA should be 0`);
    assert.equal(result.nodeIdxB[v], 1, `edge0 v${v} nodeIdxB should be 1`);
  }
  // Edge 1 (A–C): nodeIdxA=0, nodeIdxB=2
  for (let v = VERTS_PER_EDGE; v < 2 * VERTS_PER_EDGE; v++) {
    assert.equal(result.nodeIdxA[v], 0, `edge1 v${v} nodeIdxA should be 0`);
    assert.equal(result.nodeIdxB[v], 2, `edge1 v${v} nodeIdxB should be 2`);
  }
});

test("buildEdgeRibbons: lobeIdxA and lobeIdxB carry correct lobe indices", () => {
  const result = buildEdgeRibbons(GRAPH);
  // frontal=0, parietal=1, temporal=2, occipital=3, cerebellum=4, stem=5
  const frontalIdx = LOBE_INDEX.frontal;
  const parietalIdx = LOBE_INDEX.parietal;
  // Edge 0 (A–B): both frontal
  for (let v = 0; v < VERTS_PER_EDGE; v++) {
    assert.equal(result.lobeIdxA[v], frontalIdx, `edge0 v${v} lobeIdxA`);
    assert.equal(result.lobeIdxB[v], frontalIdx, `edge0 v${v} lobeIdxB`);
  }
  // Edge 1 (A–C): A=frontal, C=parietal
  for (let v = VERTS_PER_EDGE; v < 2 * VERTS_PER_EDGE; v++) {
    assert.equal(result.lobeIdxA[v], frontalIdx, `edge1 v${v} lobeIdxA`);
    assert.equal(result.lobeIdxB[v], parietalIdx, `edge1 v${v} lobeIdxB`);
  }
});

test("buildEdgeRibbons: segmentIndex — provoking vertex delivers correct segment index for each segment", () => {
  const result = buildEdgeRibbons(GRAPH);
  // All raw stored values must be in [0, 11].
  for (let v = 0; v < 2 * VERTS_PER_EDGE; v++) {
    assert.ok(result.segmentIndex[v] >= 0 && result.segmentIndex[v] <= 11,
      `vertex ${v} segmentIndex out of range: ${result.segmentIndex[v]}`);
  }
  // Model LAST_VERTEX_CONVENTION: for segment k, the GPU reads the flat segmentIndex
  // from the provoking vertex at tIdx=k+1. The delivered value must equal k.
  // Check for both edges (intra-lobe at edgeStart=0, inter-lobe at edgeStart=VERTS_PER_EDGE).
  for (const edgeStart of [0, VERTS_PER_EDGE]) {
    for (let k = 0; k < 12; k++) {
      const delivered = deliveredFlatValue(result.segmentIndex, edgeStart, k);
      assert.equal(
        delivered, k,
        `edge at ${edgeStart} seg${k}: delivered segmentIndex should be ${k}, got ${delivered}`
      );
    }
  }
});

// ---- Cloud buffer tests ----

const CLOUD_POINTS = [
  { x: 0.1, y: 0.2, z: 0.3, lobe: "frontal", twPhase: 0.5, twFreq: 0.7 },
  { x: -0.4, y: 0.6, z: -0.2, lobe: "parietal", twPhase: 1.2, twFreq: 1.0 },
  { x: 0.9, y: -0.3, z: 0.1, lobe: "temporal", twPhase: 2.0, twFreq: 0.4 }
];

test("buildCloudBuffer: positions length = pointCount * 3", () => {
  const result = buildCloudBuffer(CLOUD_POINTS);
  assert.equal(result.positions.length, 3 * 3);
});

test("buildCloudBuffer: lobeIndex length = pointCount", () => {
  const result = buildCloudBuffer(CLOUD_POINTS);
  assert.equal(result.lobeIndex.length, 3);
});

test("buildCloudBuffer: phase and freq length = pointCount", () => {
  const result = buildCloudBuffer(CLOUD_POINTS);
  assert.equal(result.phase.length, 3);
  assert.equal(result.freq.length, 3);
});

test("buildCloudBuffer: phase and freq values match source points", () => {
  const result = buildCloudBuffer(CLOUD_POINTS);
  // Float32Array has ~7 significant digits; use 1e-6 tolerance.
  const EPS = 1e-6;
  for (let i = 0; i < CLOUD_POINTS.length; i++) {
    assert.ok(Math.abs(result.phase[i] - CLOUD_POINTS[i].twPhase) < EPS,
      `phase[${i}] = ${result.phase[i]}, expected ${CLOUD_POINTS[i].twPhase}`);
    assert.ok(Math.abs(result.freq[i] - CLOUD_POINTS[i].twFreq) < EPS,
      `freq[${i}] = ${result.freq[i]}, expected ${CLOUD_POINTS[i].twFreq}`);
  }
});

test("buildCloudBuffer: position values match source points", () => {
  const result = buildCloudBuffer(CLOUD_POINTS);
  // Float32Array has ~7 significant digits; use 1e-6 tolerance.
  const EPS = 1e-6;
  for (let i = 0; i < CLOUD_POINTS.length; i++) {
    const p = CLOUD_POINTS[i];
    assert.ok(Math.abs(result.positions[i * 3 + 0] - p.x) < EPS, `pos[${i}].x`);
    assert.ok(Math.abs(result.positions[i * 3 + 1] - p.y) < EPS, `pos[${i}].y`);
    assert.ok(Math.abs(result.positions[i * 3 + 2] - p.z) < EPS, `pos[${i}].z`);
  }
});

test("buildCloudBuffer: lobeIndex values are valid 0-5", () => {
  const result = buildCloudBuffer(CLOUD_POINTS);
  for (let i = 0; i < CLOUD_POINTS.length; i++) {
    assert.ok(result.lobeIndex[i] >= 0 && result.lobeIndex[i] <= 5,
      `lobeIndex[${i}] = ${result.lobeIndex[i]}`);
  }
  // frontal=0, parietal=1, temporal=2
  assert.equal(result.lobeIndex[0], LOBE_INDEX.frontal);
  assert.equal(result.lobeIndex[1], LOBE_INDEX.parietal);
  assert.equal(result.lobeIndex[2], LOBE_INDEX.temporal);
});

// ---- Node buffer tests ----

test("buildNodeBuffer: only includes nodes with _3dLobe", () => {
  // Add a node without _3dLobe
  const nodeNoLobe = {
    id: "X", name: "X", title: "X", kind: "concept", kindLabel: "CONCEPT",
    status: "active", hub: false, degree: 0, color: "#ffffff", path: "X.md",
    classificationSource: "default"
    // No _3dLobe
  };
  const result = buildNodeBuffer([nodeA, nodeB, nodeC, nodeNoLobe]);
  // Only 3 nodes have _3dLobe
  assert.equal(result.positions.length, 3 * 3);
});

test("buildNodeBuffer: hub node radius = 6.5", () => {
  const result = buildNodeBuffer([nodeA, nodeB, nodeC]);
  // nodeA is hub
  const EPS = 1e-9;
  assert.ok(Math.abs(result.radius[0] - 6.5) < EPS, `hub radius = ${result.radius[0]}`);
});

test("buildNodeBuffer: non-hub node radius = 2.6 + min(3.4, degree*0.42)", () => {
  const result = buildNodeBuffer([nodeA, nodeB, nodeC]);
  // Float32Array has ~7 significant digits; use 1e-6 tolerance.
  const EPS = 1e-6;
  // nodeB: degree=3, non-hub → 2.6 + min(3.4, 3*0.42) = 2.6 + 1.26 = 3.86
  const expectedB = 2.6 + Math.min(3.4, 3 * 0.42);
  assert.ok(Math.abs(result.radius[1] - expectedB) < EPS,
    `nodeB radius = ${result.radius[1]}, expected ${expectedB}`);
  // nodeC: degree=1, non-hub → 2.6 + min(3.4, 1*0.42) = 2.6 + 0.42 = 3.02
  const expectedC = 2.6 + Math.min(3.4, 1 * 0.42);
  assert.ok(Math.abs(result.radius[2] - expectedC) < EPS,
    `nodeC radius = ${result.radius[2]}, expected ${expectedC}`);
});

test("buildNodeBuffer: hub flag encoded as 1 for hub, 0 for non-hub", () => {
  const result = buildNodeBuffer([nodeA, nodeB, nodeC]);
  assert.equal(result.hub[0], 1, "nodeA hub=true → 1");
  assert.equal(result.hub[1], 0, "nodeB hub=false → 0");
  assert.equal(result.hub[2], 0, "nodeC hub=false → 0");
});

test("buildNodeBuffer: status encoded as 0=active, 1=dormantRelevant, 2=archived", () => {
  const result = buildNodeBuffer([nodeA, nodeB, nodeC]);
  assert.equal(result.status[0], 0, "nodeA active → 0");
  assert.equal(result.status[1], 1, "nodeB dormantRelevant → 1");
  assert.equal(result.status[2], 2, "nodeC archived → 2");
});

test("buildNodeBuffer: positions match node._3dLobe", () => {
  const result = buildNodeBuffer([nodeA, nodeB, nodeC]);
  // Float32Array has ~7 significant digits; use 1e-6 tolerance.
  const EPS = 1e-6;
  const nodes = [nodeA, nodeB, nodeC];
  for (let i = 0; i < nodes.length; i++) {
    const lobe = nodes[i]._3dLobe;
    assert.ok(Math.abs(result.positions[i * 3 + 0] - lobe.x) < EPS, `pos[${i}].x`);
    assert.ok(Math.abs(result.positions[i * 3 + 1] - lobe.y) < EPS, `pos[${i}].y`);
    assert.ok(Math.abs(result.positions[i * 3 + 2] - lobe.z) < EPS, `pos[${i}].z`);
  }
});

test("buildNodeBuffer: node color parsed as [r/255,g/255,b/255]", () => {
  const result = buildNodeBuffer([nodeA, nodeB, nodeC]);
  const EPS = 1e-6;
  // nodeA.color = #ff1234
  assert.ok(Math.abs(result.color[0] - 0xff / 255) < EPS, "nodeA r");
  assert.ok(Math.abs(result.color[1] - 0x12 / 255) < EPS, "nodeA g");
  assert.ok(Math.abs(result.color[2] - 0x34 / 255) < EPS, "nodeA b");
});

test("buildNodeBuffer: lobeIndex carries correct lobe for each node", () => {
  const result = buildNodeBuffer([nodeA, nodeB, nodeC]);
  assert.equal(result.lobeIndex[0], LOBE_INDEX.frontal);
  assert.equal(result.lobeIndex[1], LOBE_INDEX.frontal);
  assert.equal(result.lobeIndex[2], LOBE_INDEX.parietal);
});

test("buildNodeBuffer: nodeIndex carries original array index among _3dLobe nodes", () => {
  const result = buildNodeBuffer([nodeA, nodeB, nodeC]);
  assert.equal(result.nodeIndex[0], 0);
  assert.equal(result.nodeIndex[1], 1);
  assert.equal(result.nodeIndex[2], 2);
});

// ---- incidentEdgeRanges tests ----

test("incidentEdgeRanges: returns ranges for nodes incident to edges", () => {
  const ribbonResult = buildEdgeRibbons(GRAPH);
  const ranges = incidentEdgeRanges(GRAPH, ribbonResult.edgeRanges);

  // nodeA (index 0) is in both edges
  assert.ok(ranges.has(0), "nodeA (idx 0) in ranges");
  assert.equal(ranges.get(0).length, 2, "nodeA incident to 2 edges");

  // nodeB (index 1) is only in edge 0
  assert.ok(ranges.has(1), "nodeB (idx 1) in ranges");
  assert.equal(ranges.get(1).length, 1, "nodeB incident to 1 edge");

  // nodeC (index 2) is only in edge 1
  assert.ok(ranges.has(2), "nodeC (idx 2) in ranges");
  assert.equal(ranges.get(2).length, 1, "nodeC incident to 1 edge");
});

test("incidentEdgeRanges: each range matches an edgeRange from edgeRanges", () => {
  const ribbonResult = buildEdgeRibbons(GRAPH);
  const ranges = incidentEdgeRanges(GRAPH, ribbonResult.edgeRanges);

  // nodeA's ranges should include edge 0 (start=0) and edge 1 (start=VERTS_PER_EDGE)
  const nodeARanges = ranges.get(0);
  const starts = nodeARanges.map((r) => r.start).sort((a, b) => a - b);
  assert.equal(starts[0], 0, "nodeA range 0 starts at 0");
  assert.equal(starts[1], VERTS_PER_EDGE, `nodeA range 1 starts at ${VERTS_PER_EDGE}`);
});
