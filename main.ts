import { Notice, Platform, Plugin, type EventRef, type Vault, type WorkspaceLeaf } from "obsidian";
import { ActivityListener, ActivityState, type ActivityOptions, type HttpLike, type LiveKind } from "./src/activity.ts";
import { normalizeSettings, type BrainAtlasSettings } from "./src/settings.ts";
import { BrainAtlasSettingTab } from "./src/settings-tab.ts";
import { BRAIN_ATLAS_VIEW_TYPE, BrainAtlasView } from "./src/view.ts";
import { buildPlaybackSchedule, parseTimelapse, TimelapseRecorder, type TimelapseSink } from "./src/timelapse.ts";

const LIVE_KINDS = new Set<LiveKind>(["command", "shell", "terminal", "agent"]);

export default class BrainAtlasPlugin extends Plugin {
  settings: BrainAtlasSettings = normalizeSettings(null);
  /** Live activity: node glow driven by POST /read events from Claude Code hooks. */
  activity: ActivityState = new ActivityState();
  private activityListener: ActivityListener | null = null;
  /** Timelapse: appends the action history to a JSONL file so the project's life can be replayed. */
  private recorder: TimelapseRecorder | null = null;
  private playbackTimers: number[] = [];

  async onload(): Promise<void> {
    const data = (await this.loadData()) as Partial<BrainAtlasSettings> | null;
    this.settings = normalizeSettings(data);

    this.registerView(BRAIN_ATLAS_VIEW_TYPE, (leaf: WorkspaceLeaf) => new BrainAtlasView(leaf, this));
    this.addCommand({
      id: "open-view",
      name: "Open atlas",
      callback: () => this.activateView()
    });
    this.addCommand({
      id: "play-timelapse",
      name: "Play timelapse",
      callback: () => void this.playTimelapse()
    });
    this.addCommand({
      id: "clear-timelapse",
      name: "Clear timelapse recording",
      callback: () => void this.clearTimelapse()
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
    void this.startTimelapseRecorder();
  }

  onunload(): void {
    this.activityListener?.stop();
    this.activityListener = null;
    this.cancelPlayback();
    void this.recorder?.flush();
    this.recorder = null;
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
      onEvent: (event) => {
        this.activity.activate(event.path, event.kind, performance.now());
        this.pokeActiveBrainViews(); // wake the loop so the read/write fires a signal
      },
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

  /** Where the timelapse JSONL lives (inside the plugin's own data dir, so it never clutters the vault). */
  private timelapsePath(): string {
    const dir = this.manifest.dir ?? ".obsidian/plugins/brain-atlas";
    return `${dir}/timelapse.jsonl`;
  }

  /**
   * Begin recording the action history to disk: prime from any existing file (so a reload doesn't re-append
   * old rows) and flush new entries every few seconds. Append-only; safe if the file or dir is missing.
   */
  private async startTimelapseRecorder(): Promise<void> {
    const path = this.timelapsePath();
    const adapter = this.app.vault.adapter;
    const sink: TimelapseSink = { append: (text) => adapter.append(path, text) };
    const recorder = new TimelapseRecorder(this.activity, sink);
    try {
      if (await adapter.exists(path)) recorder.primeFrom(parseTimelapse(await adapter.read(path)));
    } catch (error) {
      console.warn("Brain Atlas: could not prime timelapse from existing file.", error);
    }
    this.recorder = recorder;
    // registerInterval ties the timer to the plugin lifecycle (cleared on unload).
    this.registerInterval(window.setInterval(() => {
      if (this.settings.activityEnabled) void recorder.flush();
    }, 4000));
  }

  /** Replay the recorded history over ~30s, re-feeding events into the live activity so the brain re-glows. */
  private async playTimelapse(): Promise<void> {
    this.cancelPlayback();
    const path = this.timelapsePath();
    const adapter = this.app.vault.adapter;
    let rows;
    try {
      // Flush anything pending first so the newest actions are included.
      await this.recorder?.flush();
      if (!(await adapter.exists(path))) {
        new Notice("Brain Atlas: no timelapse recorded yet.");
        return;
      }
      rows = parseTimelapse(await adapter.read(path));
    } catch (error) {
      console.warn("Brain Atlas: could not read timelapse.", error);
      new Notice("Brain Atlas: could not read the timelapse file.");
      return;
    }
    const schedule = buildPlaybackSchedule(rows, { totalMs: 30000 });
    if (schedule.length === 0) {
      new Notice("Brain Atlas: the timelapse is empty.");
      return;
    }
    if (this.app.workspace.getLeavesOfType(BRAIN_ATLAS_VIEW_TYPE).length === 0) await this.activateView();
    new Notice(`Brain Atlas: playing ${schedule.length} actions over 30s.`);
    for (const step of schedule) {
      const timer = window.setTimeout(() => {
        this.applyPlaybackStep(step.row);
        this.pokeActiveBrainViews();
      }, step.at);
      this.playbackTimers.push(timer);
    }
  }

  /** Feed one recorded row back into the live activity state, pinned to its recorded position when we have one. */
  private applyPlaybackStep(row: { event: string; id: string; kind: string; label: string; x?: number; y?: number; z?: number }): void {
    const now = performance.now();
    const pos = row.x !== undefined && row.y !== undefined && row.z !== undefined ? { x: row.x, y: row.y, z: row.z } : undefined;
    if (row.event === "read" || row.event === "write") {
      this.activity.activate(row.id, row.event, now);
    } else if (row.event === "spawn") {
      const live = (LIVE_KINDS.has(row.kind as LiveKind) ? row.kind : "command") as LiveKind;
      this.activity.spawnLive(row.id, row.label, live, "temporal", now, "", pos);
    } else if (row.event === "end") {
      this.activity.endLive(row.id, now);
    }
  }

  private cancelPlayback(): void {
    for (const timer of this.playbackTimers) window.clearTimeout(timer);
    this.playbackTimers = [];
  }

  /** Delete the timelapse recording and start a fresh one. */
  private async clearTimelapse(): Promise<void> {
    this.cancelPlayback();
    const path = this.timelapsePath();
    const adapter = this.app.vault.adapter;
    try {
      if (await adapter.exists(path)) await adapter.remove(path);
      new Notice("Brain Atlas: timelapse cleared.");
    } catch (error) {
      console.warn("Brain Atlas: could not clear timelapse.", error);
      new Notice("Brain Atlas: could not clear the timelapse file.");
    }
    // Re-prime the recorder against the now-empty file.
    void this.startTimelapseRecorder();
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
