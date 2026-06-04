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
import type { BrainGraph, LobeName } from "../types.ts";
import { sceneProjection, projectPoint } from "./projection.ts";
import type { ProjectionOpts } from "./projection.ts";
import { hexToRgb01 } from "./color.ts";
import { createProgram, getUniformLocations, createStaticBuffer } from "./programs.ts";
import { BACKGROUND_VS, BACKGROUND_FS, HAZE_VS, HAZE_FS, CLOUD_VS, CLOUD_FS } from "./shaders.ts";
import { LOBE_CENTERS } from "../shape.ts";
import { lobeVisibilityMultiplier } from "../lobe-visibility.ts";
import { buildBrainCloud } from "../cloud.ts";
import { buildCloudBuffer, LOBE_INDEX } from "./buffers.ts";

/**
 * Lobe names ordered by their GPU LOBE_INDEX (0-5). Used to build the 6-entry
 * uLobeMul / uLobeColors uniform arrays in index order.
 */
const LOBE_BY_INDEX: LobeName[] = (() => {
  const arr: LobeName[] = new Array(6);
  for (const name in LOBE_INDEX) {
    arr[LOBE_INDEX[name as LobeName]] = name as LobeName;
  }
  return arr;
})();

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

export class BrainGLRenderer extends RenderCore {
  private gl: WebGL2RenderingContext | null = null;
  private overlay: HTMLCanvasElement | null = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;

  // Lazily created GL resources (created once, reused across frames).
  private bgProgram: BackgroundProgram | null = null;
  private hazeProgram: HazeProgram | null = null;
  private cloudProgram: CloudProgram | null = null;

  protected acquireSurface(canvas: HTMLCanvasElement): boolean {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true
    });
    if (!gl) return false;
    this.gl = gl;

    // Create the overlay canvas as a sibling that exactly overlaps the WebGL
    // canvas. It sits above the WebGL canvas and ignores pointer events so the
    // WebGL canvas remains the interaction target.
    const overlay = document.createElement("canvas");
    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    overlay.style.pointerEvents = "none";
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
    return !!this.gl;
  }

  /**
   * Test-only: the overlay canvas, so the A/B harness can composite WebGL +
   * overlay into a single readback image.
   */
  getOverlayCanvasForTest(): HTMLCanvasElement | null {
    return this.overlay;
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
    const gl = this.gl;
    if (gl && this.bgProgram) {
      gl.deleteVertexArray(this.bgProgram.vao);
      gl.deleteBuffer(this.bgProgram.quadBuffer);
      gl.deleteProgram(this.bgProgram.program);
    }
    this.bgProgram = null;
    if (gl && this.hazeProgram) {
      gl.deleteVertexArray(this.hazeProgram.vao);
      gl.deleteBuffer(this.hazeProgram.quadBuffer);
      gl.deleteProgram(this.hazeProgram.program);
    }
    this.hazeProgram = null;
    if (gl && this.cloudProgram) {
      gl.deleteVertexArray(this.cloudProgram.vao);
      gl.deleteBuffer(this.cloudProgram.vertexBuffer);
      gl.deleteProgram(this.cloudProgram.program);
    }
    this.cloudProgram = null;
    if (this.overlay && this.overlay.parentElement) {
      this.overlay.parentElement.removeChild(this.overlay);
    }
    this.overlay = null;
    this.overlayCtx = null;
    this.gl = null;
  }

  protected drawScene(now: number): void {
    const gl = this.gl;
    const graph = this.getGraph?.();
    if (!gl || !graph) return;

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
    // FAR hemisphere (projected z > 0), back of the scene:
    if (this.passEnabled("cloud")) this.drawCloud(gl, proj, now, +1, lobeMul, lobeColors);
    // if (this.passEnabled("edges")) { /* TODO Task 9: edges far (z > 0) */ }
    // if (this.passEnabled("nodes")) { /* TODO Task 10: nodes far (z > 0) */ }

    // NEAR hemisphere (projected z <= 0), front of the scene:
    if (this.passEnabled("cloud")) this.drawCloud(gl, proj, now, -1, lobeMul, lobeColors);
    // if (this.passEnabled("edges")) { /* TODO Task 9: edges near (z <= 0) */ }
    // if (this.passEnabled("nodes")) { /* TODO Task 10: nodes near (z <= 0) */ }

    // ---- Pass: signals (additive particle trails) ---- TODO Task 11
    // if (this.passEnabled("signals")) { ... }

    // ---- Pass: labels (lobe + node labels, overlay 2D) ---- TODO later task
    // if (this.passEnabled("labels")) { ... draw into this.overlayCtx ... }

    // ---- Pass: compass (orientation gizmo, overlay 2D) ---- TODO later task
    // if (this.passEnabled("compass")) { ... draw into this.overlayCtx ... }
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
}
