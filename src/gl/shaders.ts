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
