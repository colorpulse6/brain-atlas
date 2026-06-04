/**
 * GLSL ES 3.00 shader sources for the WebGL2 renderer.
 *
 * Plain string exports — no WebGL context, no DOM. Importable under node --test.
 * Each pass's vertex + fragment source is exported here and compiled lazily by
 * the renderer via createProgram().
 */

// ============================================================
// BACKGROUND PASS
// ============================================================
//
// Full-screen quad (two triangles covering clip space [-1, 1]). Reproduces the
// Canvas2D radial gradient EXACTLY:
//   ctx.createRadialGradient(cx, cy, 0, cx, cy, max(w,h)*0.75)
//     stop 0.00 -> bg
//     stop 0.55 -> bg
//     stop 1.00 -> bgFar
// i.e. flat `bg` for t <= 0.55, then linear bg->bgFar for t in (0.55, 1].
//
// Coordinate care:
//   gl_FragCoord is in DEVICE pixels with a BOTTOM-left origin. Canvas2D works
//   in CSS pixels with a TOP-left origin (the 2D ctx has a dpr transform). We
//   flip Y and divide by dpr to land in the same CSS-pixel, top-left space as
//   the Canvas2D gradient center/radius.
//
// Output is PREMULTIPLIED and opaque (alpha 1.0, so premultiplied == straight).
// Stops are interpolated in stored sRGB space (NO linearization) to match
// Canvas2D, which interpolates gradient stops in gamma-encoded space.

/** Full-screen quad vertex shader: positions provided directly in clip space. */
export const BACKGROUND_VS = `#version 300 es
precision highp float;
in vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/** Radial-gradient background fragment shader. */
export const BACKGROUND_FS = `#version 300 es
precision highp float;

uniform vec2 uResolution; // device-pixel framebuffer size (w, h)
uniform float uDpr;       // device pixel ratio
uniform vec2 uCenter;     // gradient center in CSS px (cx, cy)
uniform float uRadius;    // gradient radius in CSS px (max(w,h) * 0.75)
uniform vec3 uBg;         // inner color, stored sRGB [0,1]
uniform vec3 uBgFar;      // outer color, stored sRGB [0,1]

out vec4 outColor;

void main() {
  // gl_FragCoord: device px, origin bottom-left. Convert to CSS px, top-left.
  vec2 cssPx = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) / uDpr;

  // resize() guarantees width/height >= 1, so uRadius = max(w,h)*0.75 >= 0.75; division by zero cannot occur.
  float t = clamp(distance(cssPx, uCenter) / uRadius, 0.0, 1.0);

  // Stops: bg @0, bg @0.55, bgFar @1 (interpolate in stored sRGB space).
  vec3 c = t <= 0.55 ? uBg : mix(uBg, uBgFar, (t - 0.55) / 0.45);

  // Premultiplied, opaque: alpha 1.0 => premultiplied == straight.
  outColor = vec4(c, 1.0);
}
`;

// ============================================================
// HAZE PASS (Task 7)
// ============================================================
//
// Per-lobe additive radial-gradient glow. Each lobe (and its mirror) is drawn
// as a screen-space quad positioned around its projected center.
//
// Blend mode: additive (ONE, ONE) — matches Canvas2D "lighter" composite.
// Output is PREMULTIPLIED: vec4(color * alpha, alpha). With blendFunc(ONE, ONE)
// this accumulates correctly regardless of draw order (additive is commutative,
// so we skip the Canvas2D z-sort — see drawHaze comment in brain-gl-renderer.ts).
//
// Alpha falloff (piecewise linear, matching Canvas2D radialGradient stops):
//   t = clamp(dist(fragCssPx, center) / radius, 0, 1)
//   alpha = mix(baseA, baseA*0.45, t/0.55)          for t <= 0.55
//           mix(baseA*0.45, 0.0, (t-0.55)/0.45)     for t >  0.55
//
// Coordinate care: same as background pass — gl_FragCoord is device px,
// bottom-left origin; we divide by uDpr and flip Y to get CSS px, top-left.
// uCenter, uRadius are supplied in CSS px.
//
// The vertex shader takes a unit quad [-1,1]² (same VAO as the background quad)
// and maps it to a screen-space axis-aligned square of side 2*radius, centered
// at uCenter in CSS px. We convert CSS px → clip space using uResolution (device
// px) and uDpr so the vertex math stays in the same units as the fragment.

/** Haze quad vertex shader: unit quad → screen-space square of side 2*radius. */
export const HAZE_VS = `#version 300 es
precision highp float;

in vec2 aPosition;        // unit quad [-1, 1]², same buffer as background

uniform vec2 uResolution; // device-pixel framebuffer size (w, h)
uniform float uDpr;       // device pixel ratio
uniform vec2 uCenter;     // quad center in CSS px
uniform float uRadius;    // half-side in CSS px

void main() {
  // Map the unit quad vertex to a CSS-px position:
  //   center + aPosition * radius
  vec2 cssPx = uCenter + aPosition * uRadius;

  // Convert CSS px → NDC clip space.
  // CSS px origin is top-left; clip space origin is center with Y pointing up.
  // Step 1: convert to device px (multiply by dpr).
  // Step 2: normalize to [0,1] range in device pixels.
  // Step 3: remap to [-1,1] and flip Y (CSS top-left → GL bottom-left).
  vec2 devPx = cssPx * uDpr;
  vec2 ndc = (devPx / uResolution) * 2.0 - 1.0;
  ndc.y = -ndc.y;

  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

/** Haze radial-gradient fragment shader. Output is premultiplied additive. */
export const HAZE_FS = `#version 300 es
precision highp float;

uniform vec2 uResolution; // device-pixel framebuffer size (w, h)
uniform float uDpr;       // device pixel ratio
uniform vec2 uCenter;     // gradient center in CSS px
uniform float uRadius;    // gradient radius in CSS px
uniform vec3 uColor;      // lobe color, stored sRGB [0,1]
uniform float uBaseA;     // base alpha at t=0

out vec4 outColor;

void main() {
  // Convert fragment position to CSS px, top-left origin (same as Canvas2D).
  vec2 cssPx = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) / uDpr;

  // Radial distance parameter, clamped to [0, 1].
  float t = clamp(distance(cssPx, uCenter) / uRadius, 0.0, 1.0);

  // Piecewise linear alpha matching Canvas2D radialGradient stops:
  //   stop 0.00 -> baseA
  //   stop 0.55 -> baseA * 0.45
  //   stop 1.00 -> 0
  float alpha;
  if (t <= 0.55) {
    alpha = mix(uBaseA, uBaseA * 0.45, t / 0.55);
  } else {
    alpha = mix(uBaseA * 0.45, 0.0, (t - 0.55) / 0.45);
  }

  // Premultiplied additive output: with blendFunc(ONE, ONE) this correctly
  // accumulates multiple halos regardless of draw order (additive is commutative).
  outColor = vec4(uColor * alpha, alpha);
}
`;

// ============================================================
// CLOUD PASS (Task 8)
// ============================================================
//
// The ~1648 surface points (1400 surface + 220 cerebellum + 28 stem) are
// uploaded ONCE as a static buffer. Each point is expanded into a screen-space
// QUAD (6 vertices) whose corners carry a [-1,1]² offset (aCorner). The vertex
// shader projects the model point (reproducing projectPoint/makeProjector
// EXACTLY), classifies far = projected z > 0, and culls the whole quad if its
// far-ness does not match the requested hemisphere (uHemisphere: +1 far pass,
// -1 near pass). This is what lets drawScene run a FAR pass then a NEAR pass and
// reproduce the Canvas2D back-to-front draw order with edges/nodes interleaved
// between them in later tasks.
//
// Per-point alpha reproduces drawCloudPoint EXACTLY:
//   alphaBase = far ? 0.20 : 0.38
//   tw        = 0.65 + 0.35 * sin(uTime * 0.0005 * freq + phase)
//   alpha     = (1 - depth) * alphaBase * tw * uLobeMul[lobeIndex]
// Screen radius (CSS px): far ? 0.95 : 1.2.
//
// Color is the lobe color, supplied as uLobeColors[6] (indexed by lobeIndex);
// keeping color/visibility in uniform arrays means palette / enabledLobes /
// highlight changes need NO buffer rebuild.
//
// Analytic coverage AA: the fragment computes distance from the sprite center
// in DEVICE pixels and uses coverage = clamp(radiusDevicePx - dist + 0.5, 0, 1)
// — a ~1 device-px AA edge approximating Canvas2D's arc()+fill on the tiny dot.
// Output is premultiplied additive: vec4(color * (alpha*coverage), alpha*coverage).

/** Cloud point-sprite vertex shader. Projects model points; expands to a quad. */
export const CLOUD_VS = `#version 300 es
precision highp float;

in vec3 aPosition;    // model-space xyz
in float aLobeIndex;  // lobe index 0-5 (stored as float; integer-valued)
in float aPhase;      // twinkle phase
in float aFreq;       // twinkle frequency
in vec2 aCorner;      // quad corner offset in [-1, 1]^2

uniform vec2 uResolution;   // device-pixel framebuffer size (w, h)
uniform float uDpr;         // device pixel ratio
// Projection inputs (same values as ProjectionOpts / makeProjector).
uniform float uRotX;
uniform float uRotY;
uniform float uSceneScale;  // min(w,h) * 0.32 * zoom
uniform float uCx;
uniform float uCy;
uniform float uDist;        // 3.4
uniform float uTime;        // injected timestamp (ms) — twinkle clock
uniform float uHemisphere;  // +1.0 = far pass (z>0), -1.0 = near pass (z<=0)
uniform float uLobeMul[6];  // lobeVisibilityMultiplier per lobe

out vec2 vCornerDev;        // corner offset from sprite center, in device px
out float vRadiusDev;       // sprite radius in device px
out float vAlpha;           // per-point straight alpha
flat out int vLobe;         // lobe index (for color lookup in FS)

void main() {
  // ---- Projection (inlined from projection.ts projectPoint) ----
  float cosY = cos(uRotY);
  float sinY = sin(uRotY);
  float cosX = cos(uRotX);
  float sinX = sin(uRotX);

  float rotatedX = aPosition.x * cosY + aPosition.z * sinY;
  float z1 = -aPosition.x * sinY + aPosition.z * cosY;
  float rotatedY = aPosition.y * cosX - z1 * sinX;
  float z2 = aPosition.y * sinX + z1 * cosX;

  float f = uSceneScale / (uDist + z2);
  float sx = uCx + rotatedX * f * uDist;          // CSS px
  float sy = uCy - rotatedY * f * uDist;          // CSS px
  float depth = (z2 + 1.5) / 3.0;

  // far = projected z > 0 (matches drawCloudPoint's far classification).
  bool far = z2 > 0.0;

  // Hemisphere cull: drop the quad if its far-ness != the requested pass.
  bool wantFar = uHemisphere > 0.0;
  if (far != wantFar) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside clip space → culled
    vCornerDev = vec2(0.0);
    vRadiusDev = 0.0;
    vAlpha = 0.0;
    vLobe = 0;
    return;
  }

  // Per-point alpha (drawCloudPoint).
  float alphaBase = far ? 0.20 : 0.38;
  float tw = 0.65 + 0.35 * sin(uTime * 0.0005 * aFreq + aPhase);
  int lobe = int(aLobeIndex + 0.5);
  float lobeMul = uLobeMul[lobe];
  vAlpha = (1.0 - depth) * alphaBase * tw * lobeMul;
  vLobe = lobe;

  // Screen radius in CSS px, then device px for the analytic-coverage circle.
  float radiusCss = far ? 0.95 : 1.2;
  float radiusDev = radiusCss * uDpr;
  vRadiusDev = radiusDev;
  vCornerDev = aCorner * radiusDev;

  // Place the quad corner at screen(sx,sy) + corner * radius (CSS px), then
  // convert to clip space using the same dpr / Y-flip convention as bg/haze.
  vec2 cssPx = vec2(sx, sy) + aCorner * radiusCss;
  vec2 devPx = cssPx * uDpr;
  vec2 ndc = (devPx / uResolution) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

/** Cloud fragment shader: analytic circular coverage, premultiplied additive. */
export const CLOUD_FS = `#version 300 es
precision highp float;

uniform vec3 uLobeColors[6]; // lobe colors, stored sRGB [0,1]

in vec2 vCornerDev;   // corner offset from sprite center (device px)
in float vRadiusDev;  // sprite radius (device px)
in float vAlpha;      // per-point straight alpha
flat in int vLobe;    // lobe index

out vec4 outColor;

void main() {
  // Distance from sprite center in device px.
  float dist = length(vCornerDev);
  // ~1 device-px analytic AA edge approximating Canvas2D arc()+fill.
  float coverage = clamp(vRadiusDev - dist + 0.5, 0.0, 1.0);

  float a = vAlpha * coverage;
  vec3 color = uLobeColors[vLobe];

  // Premultiplied additive output (blendFunc(ONE, ONE)).
  outColor = vec4(color * a, a);
}
`;

// ============================================================
// EDGE PASS (Task 9)
// ============================================================
//
// Each edge is a quadratic-Bézier ribbon: 13 model-space centerline points
// expanded to 26 vertices (each point duplicated side=-1/+1), drawn as indexed
// TRIANGLES (12 segments × 2 tris). The renderer sorts edges back-to-front on the
// CPU (mean projected z descending) and re-uploads a sorted element-index buffer
// each frame, issuing ONE indexed draw per hemisphere. Because the far pass draws
// ONLY far edges (mean z > 0) and the near pass ONLY near edges, the edge-level
// `isFar` flag is a per-DRAW uniform (uIsFar), not a per-edge attribute.
//
// Reproduces drawEdge() in renderer.ts EXACTLY:
//   isFocus = focus node is an endpoint; isHover = hover node is an endpoint.
//   lobeM   = max(uLobeMul[lobeIdxA], uLobeMul[lobeIdxB])
//   interBoost = sameLobe ? 1.0 : 1.6
//   baseA = (isFocus ? (isFar?0.55:0.85)
//            : isHover ? (isFar?0.25:0.40)
//            : (isFar?0.05:0.13)) * lobeM * interBoost
//   lineWidth (CSS px) = isFocus ? 1.3 : (isFar ? 0.55 : 0.7)
//   per-segment alpha = baseA * (1 - ((p0.depth + p1.depth) / 2) * 0.35)
//   per-segment color = sameLobe ? cA : (segIdx < 6 ? cA : cB), unless isFocus → focusColor.
//
// DEPTH-FADE APPROACH: FLAT per-segment constant (chosen, not per-vertex interp).
// Canvas2D draws each of the 12 segments as a single stroke() with one constant
// alpha derived from the segment's TWO endpoint depths — a hard stair-step. We
// reproduce this exactly: at segment k's provoking vertex (tIdx k+1) we project
// aPosition (= segment END point, p1) and aSegStartRef (= segment START point, p0,
// = tIdx k) and average their depths, emitting the result as a `flat` varying so
// the whole segment strokes one constant alpha. This is byte-faithful to the
// stair-step (a per-vertex interpolated fade would smooth across segment seams and
// drift from the reference). segStartRef/aPosition are flat-correct because under
// LAST_VERTEX_CONVENTION the provoking vertex of segment k is tIdx k+1, whose
// aPosition is p1 and whose aSegStartRef is p0.
//
// RIBBON GEOMETRY + AA: the VS projects aPosition and aTangentRef (the next
// centerline point) to screen space, takes the normalized screen tangent, rotates
// it 90° for the perpendicular, and offsets the vertex by side * (halfLineWidthDev
// + 1px AA margin) in DEVICE px. The FS computes signed distance from the centerline
// and analytic coverage = clamp(halfLineWidthDev - |dist| + 0.5, 0, 1), reproducing
// Canvas2D's sub-pixel lineWidth (0.55 / 0.7 / 1.3) partial coverage.
//
// Blend: source-over premultiplied — blendFunc(ONE, ONE_MINUS_SRC_ALPHA). Edges are
// translucent and the Canvas2D draw order (sorted) is reproduced on the CPU.

/** Edge ribbon vertex shader: projects centerline, extrudes perpendicular, flat alpha/color. */
export const EDGE_VS = `#version 300 es
precision highp float;

in vec3 aPosition;     // model xyz, this centerline point (segment END at the provoking vertex)
in vec3 aTangentRef;   // model xyz of the next centerline point (for screen tangent)
in vec3 aSegStartRef;  // model xyz of the provoked segment's START point (p0)
in float aSide;        // extrusion side -1 / +1
in vec3 aColorA;       // lobe A rgb
in vec3 aColorB;       // lobe B rgb
in vec3 aFocusColor;   // edge.A.color rgb (focus override)
in float aSameLobe;    // 1 = same lobe, 0 = inter-lobe
in float aColorSelector; // flat: 0 = cA, 1 = cB (provoking-vertex corrected)
in float aLobeIdxA;    // lobe index 0-5 of endpoint A
in float aLobeIdxB;    // lobe index 0-5 of endpoint B
in float aNodeIdxA;    // node-buffer index of endpoint A
in float aNodeIdxB;    // node-buffer index of endpoint B

uniform vec2 uResolution;  // device-px framebuffer size (w, h)
uniform float uDpr;        // device pixel ratio
uniform float uRotX;
uniform float uRotY;
uniform float uSceneScale; // min(w,h) * 0.32 * zoom
uniform float uCx;
uniform float uCy;
uniform float uDist;       // 3.4
uniform float uIsFar;      // +1.0 = far pass (mean z > 0), 0.0 = near pass
uniform float uLobeMul[6]; // lobeVisibilityMultiplier per lobe
uniform float uFocusNodeIndex; // node index of focus node, or -1
uniform float uHoverNodeIndex; // node index of hover node, or -1

flat out vec3 vColor;        // per-segment color (cA / cB / focus override)
flat out float vAlpha;       // per-segment constant alpha (stair-step)
flat out float vHalfWidthDev; // half line width in device px (for AA coverage)
out float vDistFromCenter;   // signed distance from centerline in device px

// Project a model point to CSS-px screen position; also returns depth via out param.
vec2 projectCss(vec3 p, float cosX, float sinX, float cosY, float sinY, out float depth) {
  float rotatedX = p.x * cosY + p.z * sinY;
  float z1 = -p.x * sinY + p.z * cosY;
  float rotatedY = p.y * cosX - z1 * sinX;
  float z2 = p.y * sinX + z1 * cosX;
  float f = uSceneScale / (uDist + z2);
  depth = (z2 + 1.5) / 3.0;
  return vec2(uCx + rotatedX * f * uDist, uCy - rotatedY * f * uDist);
}

void main() {
  float cosY = cos(uRotY);
  float sinY = sin(uRotY);
  float cosX = cos(uRotX);
  float sinX = sin(uRotX);

  // Project this centerline point + the tangent reference + the segment-start point.
  float depthThis, depthTan, depthStart;
  vec2 cssThis = projectCss(aPosition, cosX, sinX, cosY, sinY, depthThis);
  vec2 cssTan  = projectCss(aTangentRef, cosX, sinX, cosY, sinY, depthTan);
  vec2 cssStart = projectCss(aSegStartRef, cosX, sinX, cosY, sinY, depthStart);

  // ---- Per-edge dynamic values (drawEdge) computed in-shader ----
  int lobeA = int(aLobeIdxA + 0.5);
  int lobeB = int(aLobeIdxB + 0.5);
  float lobeM = max(uLobeMul[lobeA], uLobeMul[lobeB]);
  float interBoost = aSameLobe > 0.5 ? 1.0 : 1.6;

  bool isFar = uIsFar > 0.5;

  float fIdx = uFocusNodeIndex;
  float hIdx = uHoverNodeIndex;
  bool isFocus = fIdx >= 0.0 && (abs(aNodeIdxA - fIdx) < 0.5 || abs(aNodeIdxB - fIdx) < 0.5);
  bool isHover = hIdx >= 0.0 && (abs(aNodeIdxA - hIdx) < 0.5 || abs(aNodeIdxB - hIdx) < 0.5);

  float baseA;
  if (isFocus) {
    baseA = isFar ? 0.55 : 0.85;
  } else if (isHover) {
    baseA = isFar ? 0.25 : 0.40;
  } else {
    baseA = isFar ? 0.05 : 0.13;
  }
  baseA *= lobeM * interBoost;

  float lineWidthCss = isFocus ? 1.3 : (isFar ? 0.55 : 0.7);

  // FLAT per-segment alpha (stair-step): avg of the segment's two endpoint depths.
  // At the provoking vertex (tIdx k+1) aPosition = p1 (segment END), aSegStartRef = p0.
  float avgDepth = (depthStart + depthThis) * 0.5;
  vAlpha = baseA * (1.0 - avgDepth * 0.35);

  // Per-segment color: intra-lobe → cA; inter-lobe → cA for segs 0-5, cB for 6-11
  // (delivered via flat aColorSelector). Focus edges override to focusColor.
  vec3 segColor = aColorSelector > 0.5 ? aColorB : aColorA;
  vColor = isFocus ? aFocusColor : segColor;

  // ---- Ribbon extrusion (perpendicular to screen tangent) ----
  // Half line width in device px; +1px AA margin so the FS coverage edge fits.
  float halfWidthDev = lineWidthCss * 0.5 * uDpr;
  vHalfWidthDev = halfWidthDev;
  float extrude = halfWidthDev + 1.0; // device px

  // Screen tangent (CSS px is fine for direction; scale cancels in normalize).
  vec2 dir = cssTan - cssThis;
  float len = length(dir);
  vec2 tdir = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-tdir.y, tdir.x); // 90° rotation → perpendicular

  vDistFromCenter = aSide * extrude;

  // Centerline in device px, then offset along the perpendicular by side*extrude.
  vec2 devThis = cssThis * uDpr;
  vec2 devPos = devThis + nrm * (aSide * extrude);

  // Device px → NDC (top-left CSS origin → GL bottom-left).
  vec2 ndc = (devPos / uResolution) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

/** Edge ribbon fragment shader: analytic centerline coverage, source-over premultiplied. */
export const EDGE_FS = `#version 300 es
precision highp float;

flat in vec3 vColor;
flat in float vAlpha;
flat in float vHalfWidthDev;
in float vDistFromCenter;

out vec4 outColor;

void main() {
  // Analytic coverage reproducing Canvas2D's sub-pixel lineWidth partial coverage.
  float coverage = clamp(vHalfWidthDev - abs(vDistFromCenter) + 0.5, 0.0, 1.0);
  float a = vAlpha * coverage;

  // Premultiplied source-over output (blendFunc(ONE, ONE_MINUS_SRC_ALPHA)).
  outColor = vec4(vColor * a, a);
}
`;
