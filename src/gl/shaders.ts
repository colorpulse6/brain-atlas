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
