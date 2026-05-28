import { PluginSettingTab, Setting } from "obsidian";
import type BrainAtlasPlugin from "../main.ts";
import { LOBES, setLobeEnabled } from "./lobe-visibility.ts";
import { PALETTES } from "./palette.ts";
import type { BrainAtlasSettings, PaletteName } from "./settings.ts";
import { LOBE_CENTERS } from "./shape.ts";

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
      .setName("Frontmatter kind keys")
      .setDesc("Comma-separated frontmatter fields checked for kind/type/category.")
      .addText((text) => text
        .setValue(this.plugin.settings.frontmatterKindKeys.join(", "))
        .onChange((value) => this.update({
          frontmatterKindKeys: value.split(",").map((item) => item.trim()).filter(Boolean)
        })));
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
