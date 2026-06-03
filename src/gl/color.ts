/**
 * Pure color helpers for the WebGL renderer.
 * No WebGL context, no DOM. Importable under node --test.
 *
 * Numerically locked to the hexA() helper in src/renderer.ts:
 *   function hexA(hex, alpha) {
 *     const h = hex.replace("#", "");
 *     return `rgba(${parseInt(h.slice(0,2),16)},
 *                  ${parseInt(h.slice(2,4),16)},
 *                  ${parseInt(h.slice(4,6),16)},${alpha})`;
 *   }
 * We parse in the same way (parseInt with radix 16) then divide by 255.
 */

/**
 * Parse a CSS hex color string (#rrggbb or rrggbb) into normalized [0,1] RGB.
 * Exact same parse path as hexA: strip leading "#", then parseInt(…, 16) / 255.
 */
export function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255
  ];
}

/**
 * Premultiply straight-alpha RGB by alpha, returning [r*a, g*a, b*a, a].
 *
 * WebGL2 premultiplied-alpha output convention (per the design spec):
 *   outRGB = alpha * straightRGB
 *   outA   = alpha
 * With blendFunc(ONE, ONE_MINUS_SRC_ALPHA) this is standard source-over;
 * with blendFunc(ONE, ONE) this is correct additive ("lighter") compositing.
 */
export function premultiply(
  rgb: [number, number, number],
  alpha: number
): [number, number, number, number] {
  return [rgb[0] * alpha, rgb[1] * alpha, rgb[2] * alpha, alpha];
}
