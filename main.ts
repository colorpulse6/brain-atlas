import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { normalizeSettings, type BrainAtlasSettings } from "./src/settings.ts";
import { BrainAtlasSettingTab } from "./src/settings-tab.ts";
import { BRAIN_ATLAS_VIEW_TYPE, BrainAtlasView } from "./src/view.ts";

export default class BrainAtlasPlugin extends Plugin {
  settings: BrainAtlasSettings = normalizeSettings(null);

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());

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
    await leaf.setViewState({ type: BRAIN_ATLAS_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
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
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(callback, delay);
  };
}
