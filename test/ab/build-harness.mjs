/**
 * Bundles test/ab/harness.mjs (and its TypeScript imports) into an IIFE at
 * test/ab/harness.bundle.js for use by harness.html.
 *
 * The renderer chain (renderer.ts, render-core.ts, shape.ts, palette.ts, etc.)
 * does not import from "obsidian", so no external stub is needed.
 */

import esbuild from "esbuild";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [path.join(__dirname, "harness.mjs")],
  bundle: true,
  format: "iife",
  target: "es2020",
  platform: "browser",
  logLevel: "info",
  sourcemap: false,
  treeShaking: true,
  outfile: path.join(__dirname, "harness.bundle.js"),
  // The renderer and its dependencies are pure-TS with no obsidian imports.
  // If future imports from "obsidian" sneak in, mark them external here and
  // add a stub in harness.html.
  external: ["obsidian"]
});
