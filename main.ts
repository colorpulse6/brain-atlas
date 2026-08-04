import { Notice, Plugin, type EventRef, type Vault, type WorkspaceLeaf } from "obsidian";
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
    this.registerConfigChangeRefresh();
  }

  /**
   * Editing Settings > Files & Links > Excluded files changes which notes belong in
   * the atlas, but it touches no file, so none of the vault/metadata events above
   * fire and an open view keeps showing the excluded notes until something else
   * happens to trigger a rebuild.
   *
   * Obsidian signals app-config writes through an internal "config-changed" Vault
   * event, which is not in the public typings. If a future release drops it the
   * listener simply never fires and we fall back to the previous behaviour — the
   * view refreshes on the next note edit — so this can only add responsiveness.
   */
  private registerConfigChangeRefresh(): void {
    const vault = this.app.vault as Vault & {
      on?: (name: "config-changed", callback: () => unknown) => EventRef;
    };
    try {
      const ref = vault.on?.("config-changed", () => this.debouncedRefresh());
      if (ref) this.registerEvent(ref);
    } catch (error) {
      console.warn("Brain Atlas: could not subscribe to Obsidian config changes.", error);
    }
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
