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
