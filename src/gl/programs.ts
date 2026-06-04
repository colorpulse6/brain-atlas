/**
 * Minimal hand-rolled WebGL2 program/buffer helpers.
 *
 * All WebGL2RenderingContext usage lives INSIDE functions (never at module
 * top level) so this module imports cleanly under node --test even though
 * WebGL2RenderingContext is undefined there.
 */

/** Compile a single shader stage, throwing with the info log on failure. */
function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Failed to create WebGL shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    const kind = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
    throw new Error(`WebGL ${kind} shader compile failed:\n${log ?? "(no log)"}`);
  }
  return shader;
}

/** Compile vs + fs, link them into a program, throwing with the info log on failure. */
export function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error("Failed to create WebGL program.");
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // Shaders can be deleted after linking; the program retains them.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`WebGL program link failed:\n${log ?? "(no log)"}`);
  }
  return program;
}

/** Look up a set of uniform locations by name into a record (null if absent). */
export function getUniformLocations(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: string[]
): Record<string, WebGLUniformLocation | null> {
  const out: Record<string, WebGLUniformLocation | null> = {};
  for (const name of names) {
    out[name] = gl.getUniformLocation(program, name);
  }
  return out;
}

/** Create a STATIC_DRAW buffer pre-filled with `data`. */
export function createStaticBuffer(gl: WebGL2RenderingContext, data: BufferSource): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error("Failed to create WebGL buffer.");
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return buffer;
}

/**
 * Bind `buffer` to ARRAY_BUFFER and wire it to a float vertex attribute.
 * Enables the attribute and sets the pointer (size components, no normalize).
 */
export function bindFloatAttrib(
  gl: WebGL2RenderingContext,
  buffer: WebGLBuffer,
  location: number,
  size: number,
  stride = 0,
  offset = 0
): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
}
