import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { normalizeSettings, type BrainAtlasSettings } from "./src/settings.ts";
import { BrainAtlasSettingTab } from "./src/settings-tab.ts";
import { BRAIN_ATLAS_VIEW_TYPE, BrainAtlasView } from "./src/view.ts";

export default class BrainAtlasPlugin extends Plugin {
  settings: BrainAtlasSettings = normalizeSettings(null);

  async onload(): Promise<void> {
    const data = (await this.loadData()) as Partial<BrainAtlasSettings> | null;
    this.settings = normalizeSettings(data);

    this.registerView(BRAIN_ATLAS_VIEW_TYPE, (leaf: WorkspaceLeaf) => new BrainAtlasView(leaf, this));
    this.addCommand({
      id: "open-view",
      name: "Open atlas",
      callback: () => this.activateView()
    });
    this.addRibbonIcon("brain", "Open atlas", () => this.activateView());
    this.addSettingTab(new BrainAtlasSettingTab(this));

    this.registerEvent(this.app.metadataCache.on("resolved", () => this.debouncedRefresh()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.debouncedRefresh()));
    this.registerEvent(this.app.vault.on("create", () => this.debouncedRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.debouncedRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.debouncedRefresh()));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const leaf = this.app.workspace.getLeaf(true);
    // A new main-area leaf set active is already shown; revealLeaf (Obsidian
    // 1.7.2+) is only needed to expand collapsed sidebars, so we skip it to
    // keep minAppVersion at 1.5.0.
    await leaf.setViewState({ type: BRAIN_ATLAS_VIEW_TYPE, active: true });
  }

  refreshActiveBrainViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(BRAIN_ATLAS_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof BrainAtlasView) view.rebuild();
    }
  }

  private debouncedRefresh = debounce(() => {
    try {
      this.refreshActiveBrainViews();
    } catch (error) {
      console.error("Brain Atlas refresh failed", error);
      new Notice("Brain Atlas refresh failed. See console for details.");
    }
  }, 750);
}

function debounce(callback: () => void, delay: number): () => void {
  let timeout: number | null = null;
  return () => {
    if (timeout !== null) window.clearTimeout(timeout);
    timeout = window.setTimeout(callback, delay);
  };
}
