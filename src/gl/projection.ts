/**
 * Pure projection math — numerically locked to makeProjector in src/shape.ts.
 * No WebGL context, no DOM. Importable under node --test.
 *
 * This module exposes two functions:
 *   - sceneProjection(): derives the camera opts object from draw() inputs.
 *   - projectPoint():    applies those opts to a single model-space point,
 *                        reproducing makeProjector's math exactly.
 */

import type { Vec3, ProjectedPoint } from "../types.ts";

/** The projection options understood by both makeProjector and projectPoint. */
export interface ProjectionOpts {
  rotX: number;
  rotY: number;
  scale: number;
  cx: number;
  cy: number;
  dist: number;
}

/**
 * Derive the scene-level projection opts from the renderer's draw() inputs.
 * Mirrors the body of BrainRenderer.drawScene():
 *   scale = Math.min(width, height) * 0.32 * zoom
 *   cx    = width / 2
 *   cy    = height / 2 - height * 0.04
 *   dist  = 3.4   (constant)
 */
export function sceneProjection(
  width: number,
  height: number,
  zoom: number,
  rot: { x: number; y: number }
): ProjectionOpts {
  return {
    rotX: rot.x,
    rotY: rot.y,
    scale: Math.min(width, height) * 0.32 * zoom,
    cx: width / 2,
    cy: height / 2 - height * 0.04,
    dist: 3.4
  };
}

/**
 * Project a single model-space point using the given opts.
 * Replicates makeProjector's closure math exactly — same formula, same order.
 *
 * makeProjector precomputes cos/sin once (closure) then uses them per point;
 * here we do it per call. The results are numerically identical.
 *
 * Projection steps (per shape.ts lines ~127-139):
 *   rotY rotation (around Y axis):
 *     rotatedX = x*cosY + z*sinY
 *     z1       = -x*sinY + z*cosY
 *   rotX rotation (around X axis):
 *     rotatedY = y*cosX - z1*sinX
 *     z2       = y*sinX + z1*cosX
 *   Perspective divide:
 *     f  = scale / (dist + z2)
 *     sx = cx + rotatedX * f * dist
 *     sy = cy - rotatedY * f * dist
 *   Derived per-point scale/depth (scene-scale cancels):
 *     scale = f * dist / scale  = dist / (dist + z2)
 *     depth = (z2 + 1.5) / 3
 */
export function projectPoint(opts: ProjectionOpts, point: Vec3): ProjectedPoint {
  const { rotX, rotY, scale, cx, cy, dist } = opts;
  const cosY = Math.cos(rotY);
  const sinY = Math.sin(rotY);
  const cosX = Math.cos(rotX);
  const sinX = Math.sin(rotX);

  const rotatedX = point.x * cosY + point.z * sinY;
  const z1 = -point.x * sinY + point.z * cosY;
  const rotatedY = point.y * cosX - z1 * sinX;
  const z2 = point.y * sinX + z1 * cosX;

  const f = scale / (dist + z2);
  return {
    sx: cx + rotatedX * f * dist,
    sy: cy - rotatedY * f * dist,
    z: z2,
    scale: f * dist / scale,   // = dist / (dist + z2); scene scale cancels
    depth: (z2 + 1.5) / 3
  };
}
