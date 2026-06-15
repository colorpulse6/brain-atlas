import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  {
    ignores: [
      "main.js",
      "node_modules/**",
      "scripts/**",
      "test/**",
      "esbuild.config.mjs",
      "demo/**"
    ]
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // Not enforced by the Obsidian plugin-review bot, and it false-positives on
      // technical terms (WebGL2, Canvas2D), code examples in setting descriptions,
      // and the "Brain Atlas" product name. Re-enable if Obsidian starts enforcing.
      "obsidianmd/ui/sentence-case": "off"
    }
  }
];
