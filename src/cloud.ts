/**
 * Shared brain-cloud point construction.
 *
 * Both the Canvas2D renderer (renderer.ts) and the WebGL2 renderer
 * (gl/brain-gl-renderer.ts) build their point cloud from this single pure
 * function so the two renderers operate on byte-identical points (same counts,
 * same generation order, same twPhase/twFreq). No WebGL context, no DOM, no
 * `obsidian` import — importable under node --test and by either renderer.
 *
 * The construction (1400 surface + 220 cerebellum + 28 stem = 1648 points) is
 * the exact body that previously lived in BrainRenderer.buildCloud(); do not
 * change the math, indices, or constants — the Canvas2D A/B self-check guards
 * that the rendered output is unchanged.
 */

import { Brain3D } from "./shape.ts";
import type { SurfacePoint } from "./shape.ts";

/** Build the full brain point cloud (1400 surface + 220 cerebellum + 28 stem). */
export function buildBrainCloud(): SurfacePoint[] {
  const surface = Brain3D.generateSurface(1400, 0.026).map((p, index) => ({
    ...p,
    lobe: Brain3D.lobeFor(p),
    twPhase: (index * 0.731) % (Math.PI * 2),
    twFreq: 0.4 + (index % 9) / 12
  }));
  const cerebellum: SurfacePoint[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let index = 0; index < 220; index += 1) {
    const t = (index + 0.5) / 220;
    const phi = Math.asin(2 * t - 1);
    const theta = (golden * index) % (Math.PI * 2);
    cerebellum.push({
      ...Brain3D.cerebellumPoint(theta, phi),
      lobe: "cerebellum",
      twPhase: (index * 0.91) % (Math.PI * 2),
      twFreq: 0.5 + (index % 5) / 8
    });
  }
  const stem: SurfacePoint[] = [];
  for (let index = 0; index < 28; index += 1) {
    const t = (index / 28) * 0.6;
    const a = ((index * 1.31) % 1) - 0.5;
    stem.push({ ...Brain3D.stemPoint(t, a), lobe: "stem", twPhase: index * 0.55, twFreq: 0.3 });
  }
  return [...surface, ...cerebellum, ...stem];
}
