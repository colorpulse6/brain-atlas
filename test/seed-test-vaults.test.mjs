import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { seedTestVaults, TEST_VAULTS } from "../scripts/seed-test-vaults.mjs";

test("seedTestVaults creates multiple Obsidian vault shapes without installing build assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-atlas-vaults-"));
  try {
    const result = await seedTestVaults({ rootDir: root, installPlugin: false });

    assert.equal(result.vaults.length, 6);
    assert.ok(result.vaults.every((vault) => vault.notes > 0));
    assert.deepEqual(
      result.vaults.map((vault) => vault.slug),
      TEST_VAULTS.map((vault) => vault.slug)
    );
    assert.ok(existsSync(path.join(root, "01-folder-heavy-raw", ".obsidian", "community-plugins.json")));
    assert.ok(existsSync(path.join(root, "04-frontmatter-heavy-configured", "Articles", "Wiki Note 001.md")));

    const configuredSettings = JSON.stringify(TEST_VAULTS.find((vault) => vault.slug === "04-frontmatter-heavy-configured").settings);
    assert.match(configuredSettings, /type:wiki/);
    assert.match(await readFile(path.join(root, "06-messy-import", "README.md"), "utf8"), /label-density testing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
