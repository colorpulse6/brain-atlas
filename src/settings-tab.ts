import { PluginSettingTab, Setting } from "obsidian";
import type BrainAtlasPlugin from "../main.ts";
import { normalizeKind } from "./classify.ts";
import { LOBES, setLobeEnabled } from "./lobe-visibility.ts";
import { PALETTES } from "./palette.ts";
import { normalizeLobeValue, type BrainAtlasSettings, type PaletteName } from "./settings.ts";
import { LOBE_CENTERS } from "./shape.ts";
import { CANONICAL_KINDS, type LobeName, type NodeKind } from "./types.ts";

export class BrainAtlasSettingTab extends PluginSettingTab {
  plugin: BrainAtlasPlugin;

  constructor(plugin: BrainAtlasPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Brain Atlas")
      .setHeading();

    new Setting(containerEl)
      .setName("Theme palette")
      .setDesc("Color palette used by the brain renderer.")
      .addDropdown((dropdown) => {
        for (const key of Object.keys(PALETTES)) dropdown.addOption(key, PALETTES[key].label);
        dropdown.setValue(this.plugin.settings.palette);
        dropdown.onChange((value) => this.update({ palette: value as PaletteName }));
      });

    new Setting(containerEl)
      .setName("Node cap")
      .setDesc("Maximum visible notes. Lowest-degree notes are dropped first.")
      .addSlider((slider) => slider
        .setLimits(200, 10000, 100)
        .setValue(this.plugin.settings.nodeCap)
        .setDynamicTooltip()
        .onChange((value) => this.update({ nodeCap: value })));

    new Setting(containerEl)
      .setName("Edge cap")
      .setDesc("Maximum rendered links.")
      .addSlider((slider) => slider
        .setLimits(200, 20000, 100)
        .setValue(this.plugin.settings.edgeCap)
        .setDynamicTooltip()
        .onChange((value) => this.update({ edgeCap: value })));

    new Setting(containerEl)
      .setName("Idle auto-rotate")
      .setDesc("Resume slow rotation after interaction pauses.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.idleAutoRotate)
        .onChange((value) => this.update({ idleAutoRotate: value })));

    new Setting(containerEl)
      .setName("Show labels")
      .setDesc("Draw region callouts and note labels on the brain canvas.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.showLobeLabels)
        .onChange((value) => this.update({ showLobeLabels: value })));

    new Setting(containerEl)
      .setName("Show legend chip")
      .setDesc("Show the anatomical region legend.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.showLegendChip)
        .onChange((value) => this.update({ showLegendChip: value })));

    new Setting(containerEl)
      .setName("Pinned positions")
      .setDesc(`${Object.keys(this.plugin.settings.pinnedNodePositions).length} nodes pinned by dragging.`)
      .addButton((button) => button
        .setButtonText("Reset")
        .onClick(() => this.update({ pinnedNodePositions: {} })));

    new Setting(containerEl)
      .setName("Visible regions")
      .setHeading();
    for (const lobe of LOBES) {
      new Setting(containerEl)
        .setName(formatLobeLabel(LOBE_CENTERS[lobe].label))
        .setDesc("Dim or restore this brain region in the atlas.")
        .addToggle((toggle) => toggle
          .setValue(this.plugin.settings.enabledLobes[lobe])
          .onChange((value) => this.update({
            enabledLobes: setLobeEnabled(this.plugin.settings.enabledLobes, lobe, value)
          })));
    }

    new Setting(containerEl)
      .setName("Click action")
      .setDesc("Choose where clicked notes open.")
      .addDropdown((dropdown) => dropdown
        .addOption("current", "Open in current pane")
        .addOption("new-pane", "Open in new pane")
        .addOption("hover-preview", "Hover preview")
        .setValue(this.plugin.settings.clickAction)
        .onChange((value) => this.update({ clickAction: value as BrainAtlasSettings["clickAction"] })));

    new Setting(containerEl)
      .setName("Categorization")
      .setHeading();

    new Setting(containerEl)
      .setName("Default category")
      .setDesc("Category used when no frontmatter, tag, folder, filename, or link rule matches.")
      .addDropdown((dropdown) => {
        for (const kind of CANONICAL_KINDS) dropdown.addOption(kind, formatKindLabel(kind));
        dropdown
          .setValue(this.plugin.settings.defaultKind)
          .onChange((value) => this.update({ defaultKind: value as NodeKind }));
      });

    new Setting(containerEl)
      .setName("Infer categories from links")
      .setDesc("Let uncategorized high-link notes become index or source notes when link structure strongly suggests it.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.inferKindsFromLinks)
        .onChange((value) => this.update({ inferKindsFromLinks: value })));

    new Setting(containerEl)
      .setName("Frontmatter kind keys")
      .setDesc("Comma-separated frontmatter fields checked for kind/type/category.")
      .addText((text) => text
        .setValue(this.plugin.settings.frontmatterKindKeys.join(", "))
        .onChange((value) => this.update({
          frontmatterKindKeys: value.split(",").map((item) => item.trim()).filter(Boolean)
        })));

    new Setting(containerEl)
      .setName("Tag mappings")
      .setDesc("One per line: tag=category. Tags do not need #.")
      .addTextArea((text) => {
        text.setValue(kindMapToText(this.plugin.settings.tagKindMap));
        text.inputEl.rows = 8;
        text.inputEl.addEventListener("blur", () => this.update({
          tagKindMap: parseKindMapText(text.getValue(), true)
        }));
      });

    new Setting(containerEl)
      .setName("Folder mappings")
      .setDesc("One per line: folder=category. Folder names are matched against any path ancestor.")
      .addTextArea((text) => {
        text.setValue(kindMapToText(this.plugin.settings.folderKindMap));
        text.inputEl.rows = 8;
        text.inputEl.addEventListener("blur", () => this.update({
          folderKindMap: parseKindMapText(text.getValue(), false)
        }));
      });

    new Setting(containerEl)
      .setName("Region overrides")
      .setHeading();

    new Setting(containerEl)
      .setName("Frontmatter region keys")
      .setDesc("Comma-separated frontmatter field names. Example: brain_region, lobe, region. Valid regions: frontal, parietal, temporal, occipital, cerebellum, stem.")
      .addText((text) => {
        text.inputEl.placeholder = "brain_region, lobe, region";
        text
          .setValue(this.plugin.settings.frontmatterRegionKeys.join(", "))
          .onChange((value) => this.update({
            frontmatterRegionKeys: value.split(",").map((item) => item.trim()).filter(Boolean)
          }));
      });

    new Setting(containerEl)
      .setName("Tag region mappings")
      .setDesc("One per line: tag=region. Omit # from tags. Example: client=temporal. Valid regions: frontal, parietal, temporal, occipital, cerebellum, stem.")
      .addTextArea((text) => {
        text.setValue(lobeMapToText(this.plugin.settings.tagRegionMap));
        text.inputEl.rows = 6;
        text.inputEl.placeholder = "client=temporal\nresearch=occipital\nroadmap=frontal";
        text.inputEl.addEventListener("blur", () => this.update({
          tagRegionMap: parseLobeMapText(text.getValue(), true)
        }));
      });

    new Setting(containerEl)
      .setName("Note region mappings")
      .setDesc("One per line: note/path.md=region. Use the exact vault path. Example: Projects/Big Idea.md=frontal. Valid regions: frontal, parietal, temporal, occipital, cerebellum, stem.")
      .addTextArea((text) => {
        text.setValue(lobeMapToText(this.plugin.settings.noteRegionMap));
        text.inputEl.rows = 6;
        text.inputEl.placeholder = "Projects/Big Idea.md=frontal\nPeople/Ada.md=temporal";
        text.inputEl.addEventListener("blur", () => this.update({
          noteRegionMap: parseLobeMapText(text.getValue(), false)
        }));
      });
  }

  private async update(patch: Partial<BrainAtlasSettings>): Promise<void> {
    this.plugin.settings = { ...this.plugin.settings, ...patch };
    await this.plugin.saveSettings();
    this.plugin.refreshActiveBrainViews();
  }
}

function formatLobeLabel(label: string): string {
  return label.charAt(0) + label.slice(1).toLowerCase();
}

function formatKindLabel(kind: NodeKind): string {
  switch (kind) {
    case "dailyNote":
      return "Daily note";
    case "workThread":
      return "Work thread";
    default:
      return kind.charAt(0).toUpperCase() + kind.slice(1);
  }
}

function kindMapToText(map: Record<string, NodeKind>): string {
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, kind]) => `${key}=${kind}`)
    .join("\n");
}

function lobeMapToText(map: Record<string, LobeName>): string {
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, lobe]) => `${key}=${lobe}`)
    .join("\n");
}

function parseKindMapText(value: string, lowercaseKeys: boolean): Record<string, NodeKind> {
  const map: Record<string, NodeKind> = {};
  for (const entry of value.split(/[\n,]+/)) {
    const [rawKey, rawKind] = entry.split("=");
    if (!rawKey || !rawKind) continue;
    const key = rawKey.replace(/^#/, "").trim();
    const kind = normalizeKind(rawKind);
    if (!key || !kind) continue;
    map[lowercaseKeys ? key.toLowerCase() : key] = kind;
  }
  return map;
}

function parseLobeMapText(value: string, lowercaseKeys: boolean): Record<string, LobeName> {
  const map: Record<string, LobeName> = {};
  for (const entry of value.split(/[\n,]+/)) {
    const [rawKey, rawLobe] = entry.split("=");
    if (!rawKey || !rawLobe) continue;
    const key = rawKey.replace(/^#/, "").trim();
    const lobe = normalizeLobeValue(rawLobe);
    if (!key || !lobe) continue;
    map[lowercaseKeys ? key.toLowerCase() : key] = lobe;
  }
  return map;
}
