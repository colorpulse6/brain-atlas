/**
 * Installs the built Brain Atlas plugin into a local Obsidian vault for testing.
 *
 * Usage:
 *   BRAIN_ATLAS_VAULT=/path/to/your/vault npm run install-local
 *
 * The script:
 *   1. Reads BRAIN_ATLAS_VAULT from the environment.
 *   2. Runs `npm run build` to produce main.js.
 *   3. Copies manifest.json, main.js, and styles.css into
 *      <vault>/.obsidian/plugins/brain-atlas/.
 *   4. Prints a reminder to reload Obsidian.
 *
 * The vault path is NEVER hardcoded or committed.
 */

import { execSync } from "child_process";
import { cpSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const vaultPath = process.env.BRAIN_ATLAS_VAULT;

if (!vaultPath) {
  console.error(
    "Error: BRAIN_ATLAS_VAULT environment variable is not set.\n" +
    "\n" +
    "Set it to the absolute path of your Obsidian vault, then re-run:\n" +
    "\n" +
    "  BRAIN_ATLAS_VAULT=/path/to/your/vault npm run install-local\n"
  );
  process.exit(1);
}

const pluginDir = path.join(vaultPath, ".obsidian", "plugins", "brain-atlas");

console.log("Building plugin...");
execSync("npm run build", { cwd: ROOT, stdio: "inherit" });

console.log(`\nCreating plugin directory: ${pluginDir}`);
mkdirSync(pluginDir, { recursive: true });

const assets = ["manifest.json", "main.js", "styles.css"];
for (const asset of assets) {
  const src = path.join(ROOT, asset);
  const dest = path.join(pluginDir, asset);
  if (!existsSync(src)) {
    console.error(`Error: expected build output not found: ${src}`);
    process.exit(1);
  }
  cpSync(src, dest);
  console.log(`  Copied ${asset} → ${dest}`);
}

console.log(
  "\nDone. To activate:\n" +
  "  1. Open Obsidian.\n" +
  "  2. Go to Settings → Community plugins → Installed plugins.\n" +
  "  3. Toggle Brain Atlas off then on (or fully quit and reopen Obsidian).\n"
);
