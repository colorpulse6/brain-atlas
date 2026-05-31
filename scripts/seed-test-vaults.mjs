import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ROOT = path.join(ROOT, "test-vaults", "brain-atlas");
const PLUGIN_ID = "brain-atlas";

export const TEST_VAULTS = [
  folderHeavyRawVault(),
  folderHeavyConfiguredVault(),
  frontmatterHeavyRawVault(),
  frontmatterHeavyConfiguredVault(),
  tagHeavyPkmVault(),
  messyImportVault()
];

export async function seedTestVaults(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_ROOT);
  const installPlugin = options.installPlugin ?? true;
  const reset = options.reset ?? true;
  if (reset) await rm(rootDir, { recursive: true, force: true });
  await mkdir(rootDir, { recursive: true });

  for (const vault of TEST_VAULTS) {
    await writeVault(path.join(rootDir, vault.slug), vault, installPlugin);
  }

  return {
    rootDir,
    vaults: TEST_VAULTS.map((vault) => ({
      slug: vault.slug,
      name: vault.name,
      path: path.join(rootDir, vault.slug),
      notes: vault.notes.length
    }))
  };
}

async function writeVault(vaultDir, vault, installPlugin) {
  await mkdir(path.join(vaultDir, ".obsidian"), { recursive: true });
  await writeFile(path.join(vaultDir, ".obsidian", "app.json"), JSON.stringify({ legacyEditor: false }, null, 2));
  await writeFile(path.join(vaultDir, ".obsidian", "community-plugins.json"), JSON.stringify([PLUGIN_ID], null, 2));
  await writeFile(path.join(vaultDir, "README.md"), vault.readme);
  for (const note of vault.notes) {
    const notePath = path.join(vaultDir, note.path);
    await mkdir(path.dirname(notePath), { recursive: true });
    await writeFile(notePath, note.body);
  }

  if (!installPlugin) return;
  await installBrainAtlas(vaultDir, vault.settings);
}

async function installBrainAtlas(vaultDir, settings) {
  const pluginDir = path.join(vaultDir, ".obsidian", "plugins", PLUGIN_ID);
  await mkdir(pluginDir, { recursive: true });
  for (const asset of ["manifest.json", "main.js", "styles.css"]) {
    const source = path.join(ROOT, asset);
    if (!existsSync(source)) throw new Error(`Missing ${asset}. Run npm run build before seeding local Obsidian vaults.`);
    await copyFile(source, path.join(pluginDir, asset));
  }
  await writeFile(path.join(pluginDir, "data.json"), JSON.stringify(settings ?? {}, null, 2));
}

function folderHeavyRawVault() {
  return {
    slug: "01-folder-heavy-raw",
    name: "Folder-heavy raw",
    settings: {},
    readme: readme("Folder-heavy raw", "Sparse tags and broad folders. This reproduces the default Parietal pile-up."),
    notes: [
      ...contentSeries("Channels/YouTube", "Video Brief", 28, { linksTo: ["Wiki/Knowledge Graphs"] }),
      ...contentSeries("Channels/Newsletter", "Newsletter Draft", 20, { linksTo: ["Wiki/Knowledge Graphs"] }),
      ...contentSeries("Wiki", "Knowledge Page", 36, { linksTo: ["Wiki/Knowledge Graphs"] }),
      ...contentSeries("People", "Guest", 12),
      ...contentSeries("Inbox", "Loose Capture", 18),
      note("Wiki/Knowledge Graphs.md", "# Knowledge Graphs\n\nCore reference note.\n")
    ]
  };
}

function folderHeavyConfiguredVault() {
  return {
    ...folderHeavyRawVault(),
    slug: "02-folder-heavy-configured",
    name: "Folder-heavy configured",
    settings: {
      folderKindMap: {
        Channels: "project",
        Wiki: "source",
        People: "person",
        Inbox: "concept"
      },
      folderRegionMap: {
        Channels: "frontal",
        Wiki: "occipital",
        People: "temporal",
        Inbox: "stem"
      }
    },
    readme: readme("Folder-heavy configured", "Same structure as folder-heavy raw, with folder category and region mappings enabled.")
  };
}

function frontmatterHeavyRawVault() {
  return {
    slug: "03-frontmatter-heavy-raw",
    name: "Frontmatter-heavy raw",
    settings: {},
    readme: readme("Frontmatter-heavy raw", "Arbitrary frontmatter values such as type: wiki and class: meeting. The report should surface unmapped values."),
    notes: [
      ...frontmatterSeries("Articles", "Wiki Note", 34, { type: "wiki" }),
      ...frontmatterSeries("Entities", "Person", 14, { type: "person" }),
      ...frontmatterSeries("Meetings", "Creator Sync", 12, { class: "meeting" }),
      ...frontmatterSeries("Projects", "Launch Plan", 10, { type: "project" })
    ]
  };
}

function frontmatterHeavyConfiguredVault() {
  return {
    ...frontmatterHeavyRawVault(),
    slug: "04-frontmatter-heavy-configured",
    name: "Frontmatter-heavy configured",
    settings: {
      frontmatterKindValueMap: {
        "type:wiki": "source",
        "type:person": "person",
        "class:meeting": "workThread",
        "type:project": "project"
      },
      frontmatterRegionValueMap: {
        "type:wiki": "occipital",
        "type:person": "temporal",
        "class:meeting": "parietal",
        "type:project": "frontal"
      }
    },
    readme: readme("Frontmatter-heavy configured", "Same frontmatter taxonomy as raw, with value mappings enabled.")
  };
}

function tagHeavyPkmVault() {
  return {
    slug: "05-tag-heavy-pkm",
    name: "Tag-heavy PKM",
    settings: {},
    readme: readme("Tag-heavy PKM", "Current happy path: many notes use canonical tags that Brain Atlas already understands."),
    notes: [
      ...tagSeries("Projects", "Project", 18, ["project"]),
      ...tagSeries("People", "Person", 14, ["person"]),
      ...tagSeries("Sources", "Source", 18, ["source"]),
      ...tagSeries("Concepts", "Concept", 34, ["concept"]),
      ...tagSeries("Daily", "2026-05", 18, ["daily"]),
      ...tagSeries("Indexes", "Index", 6, ["index"])
    ]
  };
}

function messyImportVault() {
  return {
    slug: "06-messy-import",
    name: "Messy import",
    settings: {
      showLobeLabels: true,
      nodeCap: 1200,
      folderRegionMap: {
        Imports: "parietal",
        UUIDs: "stem"
      }
    },
    readme: readme("Messy import", "UUID-like names, inbox folders, sparse metadata, and many low-degree notes for label-density testing."),
    notes: [
      ...contentSeries("Imports/Web Clips", "Untitled Clip", 60, { linksTo: ["Imports/Web Clips/Untitled Clip 001"] }),
      ...contentSeries("Imports/Highlights", "Highlight", 44),
      ...uuidSeries("UUIDs", 32),
      ...contentSeries("Inbox", "Capture", 28)
    ]
  };
}

function note(notePath, body) {
  return { path: notePath, body };
}

function contentSeries(folder, label, count, options = {}) {
  return Array.from({ length: count }, (_, index) => {
    const title = `${label} ${String(index + 1).padStart(3, "0")}`;
    const links = (options.linksTo ?? []).map((link) => `[[${link}]]`).join("\n");
    return note(`${folder}/${title}.md`, `# ${title}\n\n${links}\n\nSynthetic note for Brain Atlas vault-shape testing.\n`);
  });
}

function frontmatterSeries(folder, label, count, frontmatter) {
  return Array.from({ length: count }, (_, index) => {
    const title = `${label} ${String(index + 1).padStart(3, "0")}`;
    return note(`${folder}/${title}.md`, `${frontmatterBlock(frontmatter)}# ${title}\n\n[[${folder}/${label} 001]]\n`);
  });
}

function tagSeries(folder, label, count, tags) {
  return Array.from({ length: count }, (_, index) => {
    const title = `${label} ${String(index + 1).padStart(3, "0")}`;
    return note(`${folder}/${title}.md`, `# ${title}\n\n${tags.map((tag) => `#${tag}`).join(" ")}\n\n[[${folder}/${label} 001]]\n`);
  });
}

function uuidSeries(folder, count) {
  return Array.from({ length: count }, (_, index) => {
    const id = `${String(index + 1).padStart(8, "0")}-742f-4a09-9dbe-9ac17f5ff75a`;
    return note(`${folder}/${id}.md`, `# ${id}\n\nSparse imported note.\n`);
  });
}

function frontmatterBlock(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

function readme(title, description) {
  return `# ${title}\n\n${description}\n\nOpen Brain Atlas from the command palette after opening this folder as an Obsidian vault.\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootFlagIndex = process.argv.indexOf("--root");
  const rootDir = rootFlagIndex >= 0 ? process.argv[rootFlagIndex + 1] : DEFAULT_ROOT;
  const result = await seedTestVaults({ rootDir });
  console.log(`Seeded ${result.vaults.length} Brain Atlas test vaults in ${result.rootDir}`);
  for (const vault of result.vaults) {
    console.log(`- ${vault.name}: ${vault.path} (${vault.notes} notes)`);
  }
}
