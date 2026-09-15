import { Notice, Platform, Plugin, type EventRef, type Vault, type WorkspaceLeaf } from "obsidian";
import { ActivityListener, ActivityState, type ActivityOptions, type HttpLike } from "./src/activity.ts";
import { normalizeSettings, type BrainAtlasSettings } from "./src/settings.ts";
import { BrainAtlasSettingTab } from "./src/settings-tab.ts";
import { BRAIN_ATLAS_VIEW_TYPE, BrainAtlasView } from "./src/view.ts";

export default class BrainAtlasPlugin extends Plugin {
  settings: BrainAtlasSettings = normalizeSettings(null);
  /** Live activity: node glow driven by POST /read events from Claude Code hooks. */
  activity: ActivityState = new ActivityState();
  private activityListener: ActivityListener | null = null;

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
    this.applyActivitySettings();
  }

  onunload(): void {
    this.activityListener?.stop();
    this.activityListener = null;
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

  /**
   * Push the activity settings into the shared state and (re)start the loopback
   * listener. Desktop only: the listener needs Node's http module, which mobile
   * Obsidian does not expose. A bind failure (port in use) is logged once and the
   * plugin keeps working without live activity.
   */
  applyActivitySettings(): void {
    this.activity.setOptions(activityOptions(this.settings));
    this.activityListener?.stop();
    this.activityListener = null;
    if (!this.settings.activityEnabled) {
      this.activity.clear();
      return;
    }
    const http = nodeHttp();
    if (!Platform.isDesktop || !http) return;
    const listener = new ActivityListener({
      http,
      vaultBase: vaultBasePath(this.app),
      onEvent: (event) => this.activity.activate(event.path, event.kind, performance.now()),
      onLive: (event) => {
        // Mutate the shared state only; the renderer's frame loop keeps ticking while anything glows
        // (activeCount counts live nodes), so a rebuild here would only flicker the graph.
        if (event.op === "spawn") {
          this.activity.spawnLive(event.id, event.label, event.kind, event.region, performance.now(), event.detail);
        } else {
          this.activity.endLive(event.id, performance.now());
        }
        this.pokeActiveBrainViews();
      },
      status: () => this.activity.status()
    });
    this.activityListener = listener;
    listener.start(this.settings.activityPort).catch((error: unknown) => {
      console.warn(`Brain Atlas: live activity listener could not bind port ${this.settings.activityPort}.`, error);
      if (this.activityListener === listener) this.activityListener = null;
    });
  }

  /** Bound listener port (0 when off or not bound). */
  activityPort(): number {
    return this.activityListener?.boundPort ?? 0;
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

  /** Nudge open atlas views to render a frame now (a live-activity event) without a graph rebuild. */
  pokeActiveBrainViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(BRAIN_ATLAS_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof BrainAtlasView) view.poke();
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

function activityOptions(settings: BrainAtlasSettings): ActivityOptions {
  return {
    holdSeconds: settings.activityHoldSeconds,
    decaySeconds: settings.activityDecaySeconds,
    cascade: settings.activityCascade,
    swell: settings.activitySwell,
    readColor: settings.activityReadColor,
    writeColor: settings.activityWriteColor,
    liveDecaySeconds: settings.liveDecaySeconds,
    liveMaxSeconds: settings.liveMaxSeconds,
    liveShellMaxSeconds: settings.liveShellMaxSeconds,
    liveCommandColor: settings.liveCommandColor,
    liveShellColor: settings.liveShellColor,
    liveTerminalColor: settings.liveTerminalColor,
    liveAgentColor: settings.liveAgentColor
  };
}

/** Node's http module on desktop (Electron exposes require on the window); null on mobile. */
function nodeHttp(): HttpLike | null {
  try {
    const req = (window as unknown as { require?: (id: string) => unknown }).require;
    if (typeof req !== "function") return null;
    const mod = req("http") as HttpLike | undefined;
    return mod && typeof mod.createServer === "function" ? mod : null;
  } catch {
    return null;
  }
}

/** Absolute vault folder on desktop (FileSystemAdapter.getBasePath), else null. */
function vaultBasePath(app: Plugin["app"]): string | null {
  const adapter = app.vault.adapter as { getBasePath?: () => string };
  try {
    return typeof adapter.getBasePath === "function" ? adapter.getBasePath() : null;
  } catch {
    return null;
  }
}

function debounce(callback: () => void, delay: number): () => void {
  let timeout: number | null = null;
  return () => {
    if (timeout !== null) window.clearTimeout(timeout);
    timeout = window.setTimeout(callback, delay);
  };
}
