import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Scoped to test/ab rather than the repo root: rooting the glob at __dirname
  // makes Playwright descend into any git worktree checked out inside the repo,
  // load that copy's node_modules/playwright, and abort the whole run with a
  // "two instances of Playwright Test" error before a single test executes.
  testMatch: ["*.test.mjs"],
  testDir: path.join(__dirname, "test/ab"),
  timeout: 30_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  use: {
    headless: true
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" }
    }
  ]
});
