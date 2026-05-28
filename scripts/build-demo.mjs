import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["demo/demo.ts"],
  bundle: true,
  format: "iife",
  target: "es2018",
  logLevel: "info",
  sourcemap: false,
  treeShaking: true,
  outfile: "demo/brain-atlas-demo.js",
  minify: true
});
