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
import type { BrainGraph } from "../types.ts";
import { sceneProjection } from "./projection.ts";
import { hexToRgb01 } from "./color.ts";
import { createProgram, getUniformLocations, createStaticBuffer } from "./programs.ts";
import { BACKGROUND_VS, BACKGROUND_FS } from "./shaders.ts";

interface BackgroundProgram {
  program: WebGLProgram;
  quadBuffer: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

export class BrainGLRenderer extends RenderCore {
  private gl: WebGL2RenderingContext | null = null;
  private overlay: HTMLCanvasElement | null = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;

  // Lazily created GL resources (created once, reused across frames).
  private bgProgram: BackgroundProgram | null = null;

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

    // ---- Pass: haze (lobe glow, additive) ---- TODO Task 7
    // if (this.passEnabled("haze")) { ... }

    // ---- Pass: cloud (point sprites, additive, far then near halves) ---- TODO Task 8
    // if (this.passEnabled("cloud")) { ... }

    // ---- Pass: edges (ribbons, source-over, far then near halves) ---- TODO Task 9
    // if (this.passEnabled("edges")) { ... }

    // ---- Pass: nodes (halo + core + white dot + hub ring/crosshair) ---- TODO Task 10
    // if (this.passEnabled("nodes")) { ... }

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
}
