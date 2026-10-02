import { App, ItemView, Platform, TFile, WorkspaceLeaf } from "obsidian";
import { buildGraph } from "./adapter.ts";
import { LOBES, setAllLobes, setLobeEnabled } from "./lobe-visibility.ts";
import { displayNodeName, displayNodePath } from "./node-display.ts";
import { BrainRenderer } from "./renderer.ts";
import { RenderCore, type BrainRendererOptions, type LiveScreenNode } from "./render-core.ts";
import { BrainGLRenderer } from "./gl/brain-gl-renderer.ts";
import type { ActivityState, LiveEntry } from "./activity.ts";
import { LOBE_CENTERS, placeLiveNode, liveSpotClear, type LiveOccupant } from "./shape.ts";
import { DEFAULT_SETTINGS, type BrainAtlasSettings, type PinnedNodePosition } from "./settings.ts";
import type { BrainGraph, BrainNode, LobeName } from "./types.ts";

export const BRAIN_ATLAS_VIEW_TYPE = "brain-atlas";

export interface BrainAtlasPluginHost {
  app: App;
  settings: BrainAtlasSettings;
  /** Shared live-activity state; empty while the feature is off. */
  activity?: ActivityState | null;
  saveSettings(): Promise<void>;
  refreshActiveBrainViews(): void;
}

export class BrainAtlasView extends ItemView {
  private plugin: BrainAtlasPluginHost;
  private renderer: RenderCore = new BrainRenderer();
  private graph: BrainGraph | null = null;
  private rootEl: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private controlsEl: HTMLDivElement | null = null;
  private legendEl: HTMLDivElement | null = null;
  private tooltipEl: HTMLDivElement | null = null;
  private focusEl: HTMLDivElement | null = null;
  private infoEl: HTMLDivElement | null = null;
  private emptyEl: HTMLDivElement | null = null;
  /**
   * Right-hand column of collapsible cards under the controls: Layout & Display always; Active, Shells
   * and History only while live activity is on.
   */
  private dockEl: HTMLDivElement | null = null;
  private liveCardEls: HTMLDivElement[] = [];
  /** Layout & Display sliders, kept in step with the settings (they can also change in Settings). */
  private configSliders: Array<{ key: ConfigSliderKey; input: HTMLInputElement; val: HTMLSpanElement }> = [];
  private taskPanelEl: HTMLDivElement | null = null;    // Active card body: commands / terminals / agents
  private taskCountEl: HTMLSpanElement | null = null;
  private shellPanelEl: HTMLDivElement | null = null;   // Shells card body
  private shellCountEl: HTMLSpanElement | null = null;
  private historyEl: HTMLDivElement | null = null;      // History card body
  private historyCountEl: HTMLSpanElement | null = null;
  /** Keeps the dock just below the controls however many rows the region buttons wrap to. */
  private controlsResizeObserver: ResizeObserver | null = null;
  /** Per-card collapsed state (view-local). */
  private collapsed: Record<string, boolean> = { active: false, shells: false, history: false };
  /** Signatures so each card is rebuilt only when its content changes. */
  private taskPanelSig = "";
  private shellPanelSig = "";
  private historyRendered = -1;
  /** The vault-only graph (from buildGraph); live task/agent nodes are merged on top of it into this.graph. */
  private vaultGraph: BrainGraph | null = null;
  /** Signature of the live-node set currently merged into this.graph (re-merge only when it changes). */
  private mergedLiveSig = "";
  private infoButton: HTMLButtonElement | null = null;
  private labelButton: HTMLButtonElement | null = null;
  private motionButton: HTMLButtonElement | null = null;
  private allButton: HTMLButtonElement | null = null;
  private noneButton: HTMLButtonElement | null = null;
  private lobeButtons: Partial<Record<LobeName, HTMLButtonElement>> = {};
  private showInfo = false;
  private pendingOpenNodeId: string | null = null;
  private pendingOpenAt = 0;
  /** Context kind that was successfully bound to this.canvas (null = no context yet). */
  private canvasContextKind: "2d" | "webgl2" | null = null;
  /** True after a successful renderer.start() call, false after stop(). */
  private rendererStarted = false;
  /** Re-entrancy guard: true while fallbackToCanvas2D() is executing. */
  private fallingBack = false;

  constructor(leaf: WorkspaceLeaf, plugin: BrainAtlasPluginHost) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return BRAIN_ATLAS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Brain Atlas";
  }

  getIcon(): string {
    return "brain";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("brain-atlas-view");

    const root = this.contentEl.createDiv({ cls: "brain-atlas-root" });
    this.rootEl = root;
    this.syncPaletteClass();
    this.canvas = root.createEl("canvas", { cls: "brain-atlas-canvas" });
    this.createHud(root);
    this.createControls(root);
    this.legendEl = root.createDiv({ cls: "brain-atlas-legend" });
    this.infoEl = root.createDiv({ cls: "brain-atlas-info-panel" });
    this.tooltipEl = root.createDiv({ cls: "brain-atlas-tooltip" });
    this.focusEl = root.createDiv({ cls: "brain-atlas-focus-card" });
    this.emptyEl = root.createDiv({ cls: "brain-atlas-empty" });
    this.emptyEl.setText("Your brain is empty. Add notes with #project, #person, or #source tags to start mapping.");

    // Cards under the controls: Layout & Display, then the live activity cards (hidden unless the
    // feature is on, see syncDock).
    this.dockEl = root.createDiv({ cls: "brain-atlas-dock" });
    const config = this.makeCard(this.dockEl, "config", "Layout & Display", !this.plugin.settings.layoutPanelOpen);
    this.buildConfigPanel(config.body);
    const active = this.makeCard(this.dockEl, "active", "Active");
    this.taskPanelEl = active.body;
    this.taskCountEl = active.count;
    const shells = this.makeCard(this.dockEl, "shells", "Shells");
    this.shellPanelEl = shells.body;
    this.shellCountEl = shells.count;
    const history = this.makeCard(this.dockEl, "history", "History");
    this.historyEl = history.body;
    this.historyCountEl = history.count;
    this.liveCardEls = [active.card, shells.card, history.card];
    if (typeof ResizeObserver === "function" && this.controlsEl) {
      this.controlsResizeObserver = new ResizeObserver(() => this.positionDock());
      this.controlsResizeObserver.observe(this.controlsEl);
    }

    this.canvas.addEventListener("click", this.onCanvasClick);
    this.rebuild();
  }

  async onClose(): Promise<void> {
    this.canvas?.removeEventListener("click", this.onCanvasClick);
    this.controlsResizeObserver?.disconnect();
    this.controlsResizeObserver = null;
    this.renderer.stop();
    this.rendererStarted = false;
    this.rootEl = null;
    this.canvas = null;
    this.canvasContextKind = null;
    this.graph = null;
    this.vaultGraph = null;
    this.dockEl = null;
    this.liveCardEls = [];
    this.configSliders = [];
    this.taskPanelEl = null;
    this.taskCountEl = null;
    this.shellPanelEl = null;
    this.shellCountEl = null;
    this.historyEl = null;
    this.historyCountEl = null;
    this.taskPanelSig = "";
    this.shellPanelSig = "";
    this.historyRendered = -1;
  }

  onShow(): void {
    if (this.canvas && this.graph) {
      this.startRenderer();
    }
  }

  onHide(): void {
    this.renderer.stop();
    this.rendererStarted = false;
  }

  /** An activity event arrived: re-merge live nodes if the set changed (so a just-spawned node is in the graph
   *  before the next draw, and its fire signal resolves), then wake the frame loop. No vault re-read. */
  poke(): void {
    if (!this.rendererStarted) return;
    const live = this.plugin.activity?.liveNodes() ?? [];
    if (liveSignature(live) !== this.mergedLiveSig) this.composeGraph();
    // Reads/writes don't create live nodes, so refresh the history here too (change-gated internally).
    this.syncHistory();
    this.renderer.requestFrame();
  }

  rebuild(): void {
    this.vaultGraph = buildGraph(this.plugin.app, this.plugin.settings);
    // Merge the live task/agent nodes on top so they render as real graph nodes; feeds activity.setGraph too.
    this.composeGraph();
    this.syncPaletteClass();
    const wantsGL = this.plugin.settings.rendererMode === "webgl2" ||
      (this.plugin.settings.rendererMode === "auto" && !this.isMobileRuntime());
    const hasGL = this.renderer instanceof BrainGLRenderer;
    if (!this.rendererStarted || wantsGL !== hasGL) {
      // Not yet started, or renderer kind changed (mode switch): start/restart.
      this.startRenderer();
    } else {
      this.renderer.setOptions(this.rendererOptions());
    }
    this.syncOverlays();
  }

  /** Build the renderer options object from current settings. Single source of truth. */
  private rendererOptions(): BrainRendererOptions {
    return {
      idleAutoRotate: this.plugin.settings.idleAutoRotate,
      showLobeLabels: this.plugin.settings.showLobeLabels,
      liveActivity: this.plugin.settings.activityEnabled,
      ambientAnimation: this.plugin.settings.ambientAnimation,
      nodeSizeScale: this.plugin.settings.nodeSizeScale,
      linkThickness: this.plugin.settings.linkThickness,
      enabledLobes: this.plugin.settings.enabledLobes,
      performancePreset: this.plugin.settings.performancePreset,
      mobileMode: this.isMobileRuntime(),
      onPinNode: (node, position) => this.pinNode(node, position),
      onChange: this.syncOverlays,
      onLiveNodes: (nodes) => this.syncLiveNodes(nodes),
      onRendererUnavailable: () => this.fallbackToCanvas2D()
    };
  }

  /**
   * The renderer hands us the current live nodes (what Claude is doing right now) each frame while any
   * exist. The nodes themselves render as real graph nodes (see composeGraph); here we only re-merge when
   * the set changes and refresh the Active and Shells cards.
   */
  private syncLiveNodes(nodes: LiveScreenNode[]): void {
    if (liveSignature(nodes) !== this.mergedLiveSig) {
      this.composeGraph();
      this.renderer.requestFrame();
    }
    this.syncTaskPanel(nodes.filter((n) => n.kind !== "shell"));
    this.syncShellPanel(nodes.filter((n) => n.kind === "shell"));
    this.syncHistory();
  }

  /**
   * Merge the current live task/agent nodes on top of the vault graph so they render as real nodes (glow,
   * depth, hover), placed so their labels do not overlap on screen. A NEW graph object is produced so the
   * WebGL renderer rebuilds its buffers; live glow then animates per frame via the activity state.
   */
  private composeGraph(): void {
    const vault = this.vaultGraph;
    if (!vault) return;
    const live = this.plugin.activity?.liveNodes() ?? [];
    this.mergedLiveSig = liveSignature(live);
    if (live.length === 0) {
      this.graph = vault;
      this.plugin.activity?.setGraph(Object.keys(vault.idx), vault.adj);
      return;
    }
    const bySide: Record<"left" | "right", LiveEntry[]> = { left: [], right: [] };
    for (const e of live) bySide[liveSideForKind(e.kind)].push(e);
    const liveNodes: BrainNode[] = [];
    for (const side of ["left", "right"] as const) {
      // Already-placed nodes keep their spots; each new node, oldest first, takes the nearest free spot whose
      // label overlaps none of them. A task that ended and fully faded is gone from bySide, so its spot frees.
      const occupants: LiveOccupant[] = [];
      const pos = new Map<string, { x: number; y: number; z: number }>();
      const ordered = [...bySide[side]].sort((a, b) => a.seq - b.seq);
      for (const e of ordered) {
        if (e.x === undefined || e.y === undefined || e.z === undefined) continue;
        const p = { x: e.x, y: e.y, z: e.z };
        // A pinned spot is kept only while it still reads clear of the older nodes accepted so far.
        if (!liveSpotClear(e.label, p, occupants)) continue;
        pos.set(e.id, p);
        occupants.push({ label: e.label, x: p.x, y: p.y, z: p.z });
      }
      for (const e of ordered) {
        if (pos.has(e.id)) continue;
        const p = placeLiveNode(side, e.label, occupants);
        this.plugin.activity?.setLivePos(e.id, p.x, p.y, p.z);
        pos.set(e.id, p);
        occupants.push({ label: e.label, x: p.x, y: p.y, z: p.z });
      }
      for (const entry of ordered) {
        const p = pos.get(entry.id);
        if (p) liveNodes.push(this.makeLiveNode(entry, p));
      }
    }
    const idx: Record<string, BrainNode> = { ...vault.idx };
    for (const node of liveNodes) idx[node.id] = node;
    this.graph = { ...vault, nodes: [...vault.nodes, ...liveNodes], idx, adj: vault.adj };
    this.plugin.activity?.setGraph(Object.keys(idx), vault.adj);
  }

  /**
   * A live task/agent as a real BrainNode on a temporal face: RIGHT for foreground commands and terminals,
   * LEFT for background shells and agents. The on-node name is short; the full command is in entry.detail
   * (shown in the Active card, not on the map).
   */
  private makeLiveNode(entry: LiveEntry, pos: { x: number; y: number; z: number }): BrainNode {
    const kindLabel = entry.kind === "shell" ? "background shell"
      : entry.kind === "agent" ? "agent"
        : entry.kind === "terminal" ? "terminal" : "command";
    return {
      id: entry.id,
      name: entry.label,
      title: entry.label,
      kind: "workThread",
      kindLabel,
      status: "active",
      hub: false,
      degree: 0,
      color: this.plugin.activity ? this.plugin.activity.liveColorFor(entry) : "#ffb02e",
      path: entry.detail || entry.label,
      classificationSource: "frontmatter",
      _lobeName: "temporal",
      _3dLobe: pos
    };
  }

  /** A collapsible card: a clickable header (chevron + title + count) over a body the sync methods fill. */
  private makeCard(
    parent: HTMLElement,
    key: string,
    title: string,
    collapsed = !!this.collapsed[key]
  ): { card: HTMLDivElement; count: HTMLSpanElement; body: HTMLDivElement } {
    this.collapsed[key] = collapsed;
    const card = parent.createDiv({ cls: "brain-atlas-card" });
    card.setAttr("data-card", key);
    card.toggleClass("is-collapsed", collapsed);
    const header = card.createDiv({ cls: "brain-atlas-card-header" });
    header.createSpan({ cls: "brain-atlas-card-chevron", text: "\u25BE" });
    header.createSpan({ cls: "brain-atlas-card-title", text: title });
    const count = header.createSpan({ cls: "brain-atlas-card-count" });
    header.addEventListener("click", () => {
      const next = !card.hasClass("is-collapsed");
      card.toggleClass("is-collapsed", next);
      this.collapsed[key] = next;
      if (key === "config") {
        // The only card whose open state is remembered between sessions.
        this.plugin.settings.layoutPanelOpen = !next;
        void this.plugin.saveSettings();
      }
    });
    const body = card.createDiv({ cls: "brain-atlas-card-body" });
    return { card, count, body };
  }

  /** Show the live cards only while the feature is on; keep the dock below the controls (and the Info panel). */
  private syncDock(): void {
    for (const card of this.liveCardEls) card.toggleClass("is-hidden", !this.plugin.settings.activityEnabled);
    this.syncConfigPanel();
    this.positionDock();
  }

  private positionDock(): void {
    if (!this.dockEl || !this.controlsEl) return;
    let top = this.controlsEl.offsetTop + this.controlsEl.offsetHeight + 8;
    if (this.showInfo && this.infoEl) top = Math.max(top, this.infoEl.offsetTop + this.infoEl.offsetHeight + 8);
    this.dockEl.style.top = `${top}px`;
  }

  /**
   * The Layout & Display card: the same node size, layout spread and link thickness as Settings.
   * Size and spread change the layout, so they apply on release (a rebuild); link thickness is a
   * render option, so it follows the slider and saves on release.
   */
  private buildConfigPanel(body: HTMLElement): void {
    body.empty();
    this.configSliders = [];
    this.addConfigSlider(body, "nodeSizeScale", "Node size", (v) => {
      this.plugin.settings.nodeSizeScale = v;
      void this.persistViewSettings();
    });
    this.addConfigSlider(body, "layoutSpread", "Layout spread", (v) => {
      this.plugin.settings.layoutSpread = v;
      void this.persistViewSettings();
    }, "Low keeps notes close in each region; high spreads them through the region");
    this.addConfigSlider(body, "linkThickness", "Link thickness", (v) => {
      this.plugin.settings.linkThickness = v;
      void this.plugin.saveSettings();
    }, undefined, (v) => this.renderer.setOptions({ linkThickness: v }));
    const resetRow = body.createDiv({ cls: "brain-atlas-config-reset-row" });
    this.createControlButton(resetRow, "Reset to default", () => {
      this.plugin.settings.nodeSizeScale = DEFAULT_SETTINGS.nodeSizeScale;
      this.plugin.settings.layoutSpread = DEFAULT_SETTINGS.layoutSpread;
      this.plugin.settings.linkThickness = DEFAULT_SETTINGS.linkThickness;
      void this.persistViewSettings();
    });
  }

  /** One labelled slider. `commit` runs on release; `preview` (optional) runs on every tick while dragging. */
  private addConfigSlider(
    parent: HTMLElement,
    key: ConfigSliderKey,
    label: string,
    commit: (value: number) => void,
    tooltip?: string,
    preview?: (value: number) => void
  ): void {
    const range = CONFIG_SLIDER_RANGE[key];
    const value = this.plugin.settings[key];
    const row = parent.createDiv({ cls: "brain-atlas-config-row" });
    if (tooltip) row.setAttr("title", tooltip);
    const head = row.createDiv({ cls: "brain-atlas-config-head" });
    head.createSpan({ cls: "brain-atlas-config-label", text: label });
    const val = head.createSpan({ cls: "brain-atlas-config-val", text: value.toFixed(1) });
    const input = row.createEl("input", { cls: "brain-atlas-config-slider" });
    input.type = "range";
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = "0.1";
    input.value = String(value);
    input.setAttr("aria-label", label);
    input.addEventListener("input", () => {
      val.setText(Number(input.value).toFixed(1));
      preview?.(Number(input.value));
    });
    input.addEventListener("change", () => commit(Number(input.value)));
    this.configSliders.push({ key, input, val });
  }

  /** Follow changes made in Settings or by Reset; leave a slider alone while the user is dragging it. */
  private syncConfigPanel(): void {
    for (const { key, input, val } of this.configSliders) {
      if (input.ownerDocument.activeElement === input) continue;
      const value = this.plugin.settings[key];
      if (Number(input.value) === value) continue;
      input.value = String(value);
      val.setText(value.toFixed(1));
    }
  }

  /** The Active card body: every live task (commands / terminals / agents) grouped by kind. */
  private syncTaskPanel(nodes: LiveScreenNode[]): void {
    const panel = this.taskPanelEl;
    if (!panel) return;
    const running = nodes.filter((n) => n.active).length;
    this.taskCountEl?.setText(nodes.length ? `${running} running` : "");
    const sig = liveSignature(nodes);
    if (sig === this.taskPanelSig) return;
    this.taskPanelSig = sig;
    panel.empty();
    if (nodes.length === 0) {
      panel.createDiv({ cls: "brain-atlas-history-empty", text: "nothing running" });
      return;
    }
    const groups: Array<{ kind: string; title: string }> = [
      { kind: "command", title: "Commands" },
      { kind: "terminal", title: "Terminals" },
      { kind: "agent", title: "Agents" }
    ];
    for (const group of groups) {
      const rows = nodes.filter((n) => n.kind === group.kind);
      if (rows.length === 0) continue;
      const section = panel.createDiv({ cls: "brain-atlas-task-group" });
      section.createDiv({ cls: "brain-atlas-task-group-title", text: `${group.title} - ${rows.length}` });
      for (const node of rows) this.createTaskRow(section, node);
    }
  }

  /** The Shells card body: background shells (they end on their TTL, not on an end event). */
  private syncShellPanel(shells: LiveScreenNode[]): void {
    const panel = this.shellPanelEl;
    if (!panel) return;
    const running = shells.filter((n) => n.active).length;
    this.shellCountEl?.setText(shells.length ? `${running} active` : "");
    const sig = liveSignature(shells);
    if (sig === this.shellPanelSig) return;
    this.shellPanelSig = sig;
    panel.empty();
    if (shells.length === 0) {
      panel.createDiv({ cls: "brain-atlas-history-empty", text: "no background shells" });
      return;
    }
    for (const node of shells) this.createTaskRow(panel, node);
  }

  private createTaskRow(parent: HTMLElement, node: LiveScreenNode): void {
    const row = parent.createDiv({ cls: "brain-atlas-task-row" });
    row.toggleClass("is-ending", !node.active);
    row.setAttr("data-kind", node.kind);
    row.style.setProperty("--live-color", node.color);
    row.createSpan({ cls: "brain-atlas-task-dot" });
    const body = row.createDiv({ cls: "brain-atlas-task-body" });
    body.createSpan({ cls: "brain-atlas-task-name", text: node.label });
    if (node.detail && node.detail !== node.label) body.createSpan({ cls: "brain-atlas-task-detail", text: node.detail });
    row.createSpan({ cls: "brain-atlas-task-status", text: node.active ? "running" : "done" });
  }

  /** The History card body: a scrollable log of every action (reads, writes, spawns, ends), newest first. */
  private syncHistory(): void {
    const el = this.historyEl;
    const activity = this.plugin.activity;
    if (!el || !activity) return;
    const count = activity.historyCount();
    this.historyCountEl?.setText(count ? String(count) : "");
    if (count === this.historyRendered) return;
    this.historyRendered = count;
    el.empty();
    const rows = activity.recentHistory(200);
    if (rows.length === 0) {
      el.createDiv({ cls: "brain-atlas-history-empty", text: "no activity yet" });
      return;
    }
    for (const h of rows) {
      const row = el.createDiv({ cls: "brain-atlas-history-row" });
      row.setAttr("data-event", h.event);
      row.style.setProperty("--live-color", h.color);
      row.createSpan({ cls: "brain-atlas-history-verb", text: HISTORY_VERB[h.event] ?? h.event });
      row.createSpan({ cls: "brain-atlas-history-label", text: h.label });
    }
  }

  /** Select the desired renderer kind based on rendererMode + mobile detection. */
  private selectRenderer(): RenderCore {
    const mode = this.plugin.settings.rendererMode;
    if (mode === "canvas2d") return new BrainRenderer();
    if (mode === "webgl2" || (mode === "auto" && !this.isMobileRuntime())) {
      return new BrainGLRenderer();
    }
    return new BrainRenderer();
  }

  /**
   * Called when the WebGL renderer signals permanent context loss. Stops the
   * WebGL renderer, recreates the canvas (the lost context taints the current
   * one), constructs a Canvas2D renderer, and starts it seamlessly. Guards
   * against re-entrancy so a lost context during the fallback itself can't loop.
   */
  private fallbackToCanvas2D(): void {
    // Re-entrancy guard: if we're already falling back, do nothing.
    if (this.fallingBack) return;
    // If we're already on Canvas2D there's nothing to fall back to.
    if (!(this.renderer instanceof BrainGLRenderer)) return;
    if (!this.canvas || !this.rootEl) return;

    this.fallingBack = true;
    try {
      this.renderer.stop();
      this.rendererStarted = false;
      // The WebGL canvas's context is lost/tainted — use recreateCanvas() so the
      // Canvas2D renderer gets a clean canvas.
      this.recreateCanvas();
      const getGraph = (): BrainGraph => this.graph ?? emptyGraph(this.plugin.settings);
      const options = this.rendererOptions();
      const fallback = new BrainRenderer();
      fallback.setActivity(this.plugin.activity ?? null);
      try {
        fallback.start(this.canvas, getGraph, options);
        this.renderer = fallback;
        this.canvasContextKind = "2d";
        this.rendererStarted = true;
      } catch {
        // Canvas2D also failed — show the no-renderer error state.
        this.showNoRendererError();
      }
    } finally {
      this.fallingBack = false;
    }
  }

  /**
   * Show the empty-state overlay with an error message when no renderer could
   * be started. Reuses emptyEl; the normal empty-state message is restored by
   * onOpen (which reinitialises the element) or a successful subsequent start.
   */
  private showNoRendererError(): void {
    if (!this.emptyEl) return;
    this.emptyEl.setText(
      "Brain Atlas couldn’t start a renderer (WebGL2 and Canvas2D both unavailable)."
    );
    this.emptyEl.addClass("is-visible");
  }

  /**
   * Destroy the current canvas and replace it with a fresh one, re-attaching
   * the click listener. Call this when the canvas context KIND must change
   * (e.g. webgl2 → 2d) because a canvas's context type is permanently locked
   * after the first successful getContext() call.
   */
  private recreateCanvas(): void {
    if (!this.rootEl) return;
    this.canvas?.removeEventListener("click", this.onCanvasClick);
    this.canvas?.remove();
    const fresh = this.rootEl.createEl("canvas", { cls: "brain-atlas-canvas" });
    // Insert before any existing first child so the canvas sits UNDER the HUD,
    // controls, and legend in the stacking order.
    this.rootEl.prepend(fresh);
    fresh.addEventListener("click", this.onCanvasClick);
    this.canvas = fresh;
    this.canvasContextKind = null;
  }

  /**
   * Stop the current renderer, construct the desired one, and start it on
   * this.canvas. Recreates the canvas when the context KIND changes (webgl2 ↔
   * 2d), because a canvas's context type is permanently locked after the first
   * successful getContext() call. Falls back to Canvas2D if the desired
   * renderer throws (e.g. WebGL2 unavailable), so the view never breaks.
   */
  private startRenderer(): void {
    if (!this.canvas || !this.rootEl) return;
    const getGraph = (): BrainGraph => this.graph ?? emptyGraph(this.plugin.settings);
    const options = this.rendererOptions();

    this.renderer.stop();
    this.rendererStarted = false;

    const desired = this.selectRenderer();
    const desiredKind: "webgl2" | "2d" = desired instanceof BrainGLRenderer ? "webgl2" : "2d";

    // If the existing canvas is locked to a DIFFERENT context kind, we must
    // replace it. When canvasContextKind is null no context has been
    // successfully created yet, so the current canvas is still usable.
    if (this.canvasContextKind !== null && this.canvasContextKind !== desiredKind) {
      this.recreateCanvas();
    }

    const canvas = this.canvas;

    desired.setActivity(this.plugin.activity ?? null);
    try {
      desired.start(canvas, getGraph, options);
      this.renderer = desired;
      this.canvasContextKind = desiredKind;
      this.rendererStarted = true;
    } catch {
      // WebGL2 context creation failed — fall back to Canvas2D so the view
      // always renders even when WebGL is unavailable or disabled.
      // If getContext("webgl2") returned null the canvas is NOT tainted, so
      // Canvas2D can bind to it directly. If for some reason it IS tainted
      // (should not happen on a null return), recreate first.
      const fallback = new BrainRenderer();
      fallback.setActivity(this.plugin.activity ?? null);
      try {
        fallback.start(canvas, getGraph, options);
        this.renderer = fallback;
        this.canvasContextKind = "2d";
        this.rendererStarted = true;
      } catch {
        // Canvas still tainted from a previous kind — recreate and retry once.
        this.recreateCanvas();
        try {
          fallback.start(this.canvas, getGraph, options);
          this.renderer = fallback;
          this.canvasContextKind = "2d";
          this.rendererStarted = true;
        } catch {
          // Canvas2D start also failed; both renderers are unavailable.
          // Show a visible error state so the user sees the view isn't blank by accident.
          this.showNoRendererError();
        }
      }
    }
  }

  private isMobileRuntime(): boolean {
    if (Platform.isMobile) return true;
    if (typeof window === "undefined") return false;
    return window.innerWidth <= 700 || (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches
    );
  }

  private createHud(root: HTMLElement): void {
    const hud = root.createDiv({ cls: "brain-atlas-hud" });
    hud.createSpan({ cls: "brain-atlas-pulse" });
    hud.createSpan({ text: "LOBE - ATLAS - v2" });
    hud.createSpan({ cls: "brain-atlas-muted", text: " -" });
    hud.createSpan({ text: " 6 regions" });

    const help = root.createDiv({ cls: "brain-atlas-help" });
    help.setText("DRAG NODE - pin   -   DRAG EMPTY - rotate   -   SCROLL - zoom");
  }

  private createControls(root: HTMLElement): void {
    this.controlsEl = root.createDiv({ cls: "brain-atlas-controls" });
    const primary = this.controlsEl.createDiv({ cls: "brain-atlas-control-group" });
    this.infoButton = this.createControlButton(primary, "Info", () => this.toggleInfo());
    this.labelButton = this.createControlButton(primary, "Labels", () => this.toggleLabels());
    this.motionButton = this.createControlButton(primary, "Motion", () => this.toggleMotion());
    this.motionButton.setAttr("aria-label", "Ambient animation: cloud twinkle and signals between regions");
    this.allButton = this.createControlButton(primary, "All", () => this.setAllRegions(true));
    this.noneButton = this.createControlButton(primary, "None", () => this.setAllRegions(false));
    this.createControlButton(primary, "Reset", () => this.renderer.resetView())
      .setAttr("aria-label", "Reset rotation, zoom and pan");

    const lobes = this.controlsEl.createDiv({ cls: "brain-atlas-control-group brain-atlas-region-controls" });
    for (const lobe of LOBES) {
      this.lobeButtons[lobe] = this.createControlButton(lobes, shortLobeLabel(lobe), () => this.toggleLobe(lobe));
      this.lobeButtons[lobe]?.setAttr("aria-label", `${LOBE_CENTERS[lobe].label} region`);
    }
  }

  private createControlButton(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "brain-atlas-control-button", text: label });
    button.type = "button";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  private syncOverlays = (): void => {
    const graph = this.graph;
    if (!graph) return;
    this.syncControls();
    this.syncLegend(graph);
    this.syncInfoPanel();
    this.syncDock();
    this.syncTooltip();
    this.syncFocusCard();
    this.emptyEl?.toggleClass("is-visible", graph.nodes.length === 0);
  };

  private syncPaletteClass(): void {
    this.rootEl?.toggleClass("is-light-palette", this.plugin.settings.palette === "daylight");
  }

  private syncControls(): void {
    const enabled = this.plugin.settings.enabledLobes;
    this.infoButton?.toggleClass("is-active", this.showInfo);
    this.infoButton?.setAttr("aria-pressed", String(this.showInfo));
    this.labelButton?.toggleClass("is-active", this.plugin.settings.showLobeLabels);
    this.labelButton?.setAttr("aria-pressed", String(this.plugin.settings.showLobeLabels));
    this.motionButton?.toggleClass("is-active", this.plugin.settings.ambientAnimation);
    this.motionButton?.setAttr("aria-pressed", String(this.plugin.settings.ambientAnimation));
    const enabledCount = LOBES.filter((lobe) => enabled[lobe]).length;
    this.allButton?.toggleClass("is-active", enabledCount === LOBES.length);
    this.noneButton?.toggleClass("is-active", enabledCount === 0);
    for (const lobe of LOBES) {
      const button = this.lobeButtons[lobe];
      if (!button) continue;
      button.toggleClass("is-active", enabled[lobe]);
      button.setAttr("aria-pressed", String(enabled[lobe]));
    }
  }

  private syncLegend(graph: BrainGraph): void {
    if (!this.legendEl) return;
    this.legendEl.empty();
    this.legendEl.toggleClass("is-hidden", !this.plugin.settings.showLegendChip);
    this.legendEl.createDiv({ cls: "brain-atlas-legend-title", text: "Anatomical regions" });
    const stats = this.renderer.getLobeStats();
    for (const lobe of Object.keys(LOBE_CENTERS) as LobeName[]) {
      const center = LOBE_CENTERS[lobe];
      const color = lobeColor(lobe, graph);
      const enabled = this.plugin.settings.enabledLobes[lobe];
      const row = this.legendEl.createDiv({ cls: "brain-atlas-legend-row" });
      row.toggleClass("is-disabled", !enabled);
      row.setAttr("role", "button");
      row.setAttr("aria-pressed", String(enabled));
      row.addEventListener("mouseenter", () => this.renderer.setHighlightLobe(lobe));
      row.addEventListener("mouseleave", () => this.renderer.setHighlightLobe(null));
      row.addEventListener("click", () => this.toggleLobe(lobe));
      row.createSpan({ cls: "brain-atlas-swatch" }).style.setProperty("--brain-atlas-swatch", color);
      const text = row.createDiv({ cls: "brain-atlas-legend-copy" });
      text.createSpan({ cls: "brain-atlas-legend-label", text: center.label });
      text.createSpan({ cls: "brain-atlas-legend-sub", text: lobeSubtitle(lobe) });
      row.createSpan({ cls: "brain-atlas-legend-count", text: String(stats[lobe] ?? 0).padStart(2, "0") });
    }
  }

  private syncTooltip(): void {
    if (!this.tooltipEl) return;
    const node = this.renderer.getHoveredNode();
    this.tooltipEl.toggleClass("is-visible", !!node);
    if (!node) return;
    this.tooltipEl.empty();
    this.tooltipEl.createDiv({ cls: "brain-atlas-tooltip-title", text: displayNodeName(node) });
    this.tooltipEl.createDiv({ cls: "brain-atlas-tooltip-sub", text: `${node.kindLabel} - ${node.degree} links` });
    this.tooltipEl.createDiv({ cls: "brain-atlas-tooltip-source", text: `classified by ${formatClassificationSource(node.classificationSource)}` });
    this.tooltipEl.createDiv({ cls: "brain-atlas-tooltip-path", text: displayNodePath(node) });
  }

  private syncFocusCard(): void {
    if (!this.focusEl) return;
    const node = this.renderer.getFocusedNode();
    this.focusEl.toggleClass("is-visible", !!node);
    if (!node) return;
    this.focusEl.empty();
    this.focusEl.createDiv({
      cls: "brain-atlas-focus-meta",
      text: `${node.kindLabel} - ${formatClassificationSource(node.classificationSource)} - ${node.status.toUpperCase()}`
    });
    this.focusEl.createDiv({ cls: "brain-atlas-focus-title", text: displayNodeName(node) });
    this.focusEl.createDiv({ cls: "brain-atlas-focus-sub", text: `${node.degree} links - ${displayNodePath(node)}` });
    if (this.isCoarsePointer()) {
      this.focusEl.createDiv({ cls: "brain-atlas-focus-hint", text: "Tap again to open" });
    }
  }

  private syncInfoPanel(): void {
    if (!this.infoEl) return;
    this.infoEl.toggleClass("is-visible", this.showInfo);
    if (!this.showInfo) {
      this.infoEl.empty();
      return;
    }

    this.infoEl.empty();
    this.infoEl.createDiv({ cls: "brain-atlas-info-title", text: "What am I seeing?" });
    this.infoEl.createDiv({
      cls: "brain-atlas-info-copy",
      text: "Dots are Markdown notes. Lines are wikilinks and embeds resolved from Obsidian metadata."
    });
    this.infoEl.createDiv({
      cls: "brain-atlas-info-copy",
      text: "Regions come from frontmatter, tags, folders, daily-note names, then your default category and optional link behavior."
    });
    this.infoEl.createDiv({
      cls: "brain-atlas-info-copy",
      text: "Region buttons isolate lobes. Labels toggles note and region text."
    });
  }

  private onCanvasClick = (event: MouseEvent): void => {
    if (!this.canvas) return;
    if (this.renderer.consumeSuppressedClick()) return;
    const interactionTarget = this.renderer.getInteractionTarget() ?? this.canvas;
    const rect = interactionTarget.getBoundingClientRect();
    const hit = this.renderer.hitTest(event.clientX - rect.left, event.clientY - rect.top);
    if (!hit) return;
    if (this.shouldPreviewBeforeOpen(hit)) return;
    this.pendingOpenNodeId = null;
    this.openNode(hit);
  };

  private shouldPreviewBeforeOpen(node: BrainNode): boolean {
    if (!this.isCoarsePointer()) return false;
    const now = performance.now();
    const isSecondTap = this.pendingOpenNodeId === node.id && now - this.pendingOpenAt < 1800;
    this.pendingOpenNodeId = node.id;
    this.pendingOpenAt = now;
    this.syncFocusCard();
    return !isSecondTap;
  }

  private isCoarsePointer(): boolean {
    return window.matchMedia?.("(pointer: coarse)").matches ?? false;
  }

  private openNode(node: BrainNode): void {
    const file = this.plugin.app.vault.getAbstractFileByPath(node.id);
    if (!(file instanceof TFile)) return;
    void this.plugin.app.workspace.getLeaf(this.plugin.settings.clickAction === "new-pane").openFile(file);
  }

  private pinNode(node: BrainNode, position: PinnedNodePosition): void {
    const activity = this.plugin.activity;
    if (activity && activity.liveNodes().some((e) => e.id === node.id)) {
      // A dragged live node keeps its spot in the activity state, never in the vault settings.
      activity.setLivePos(node.id, position.x, position.y, position.z);
      return;
    }
    this.plugin.settings = {
      ...this.plugin.settings,
      pinnedNodePositions: {
        ...this.plugin.settings.pinnedNodePositions,
        [node.id]: position
      }
    };
    void this.plugin.saveSettings();
  }

  private toggleLabels(): void {
    this.plugin.settings.showLobeLabels = !this.plugin.settings.showLobeLabels;
    this.renderer.setOptions({ showLobeLabels: this.plugin.settings.showLobeLabels });
    this.syncOverlays();
    void this.persistViewSettings();
  }

  private toggleMotion(): void {
    this.plugin.settings.ambientAnimation = !this.plugin.settings.ambientAnimation;
    this.renderer.setOptions({ ambientAnimation: this.plugin.settings.ambientAnimation });
    this.syncOverlays();
    void this.persistViewSettings();
  }

  private toggleInfo(): void {
    this.showInfo = !this.showInfo;
    this.syncOverlays();
  }

  private toggleLobe(lobe: LobeName): void {
    const current = this.plugin.settings.enabledLobes[lobe];
    this.plugin.settings.enabledLobes = setLobeEnabled(this.plugin.settings.enabledLobes, lobe, !current);
    this.renderer.setOptions({ enabledLobes: this.plugin.settings.enabledLobes });
    this.syncOverlays();
    void this.persistViewSettings();
  }

  private setAllRegions(enabled: boolean): void {
    this.plugin.settings.enabledLobes = setAllLobes(enabled);
    this.renderer.setOptions({ enabledLobes: this.plugin.settings.enabledLobes });
    this.syncOverlays();
    void this.persistViewSettings();
  }

  private async persistViewSettings(): Promise<void> {
    await this.plugin.saveSettings();
    this.plugin.refreshActiveBrainViews();
  }
}

type ConfigSliderKey = "nodeSizeScale" | "layoutSpread" | "linkThickness";

/** Slider limits; the same as the Settings sliders and normalizeSettings. */
const CONFIG_SLIDER_RANGE: Record<ConfigSliderKey, { min: number; max: number }> = {
  nodeSizeScale: { min: 0.4, max: 3 },
  layoutSpread: { min: 0.5, max: 2.5 },
  linkThickness: { min: 0.4, max: 3 }
};

/** Change signature of a live-node list: which nodes exist, and whether each is still running. */
function liveSignature(nodes: Array<{ id: string; active: boolean; kind: string }>): string {
  return nodes.map((n) => `${n.id}:${n.active ? 1 : 0}:${n.kind}`).join("|");
}

/** Which temporal side a live kind sits on: foreground work (commands, terminals) right; shells and agents left. */
function liveSideForKind(kind: string): "left" | "right" {
  return kind === "command" || kind === "terminal" ? "right" : "left";
}

/** Short verb shown at the start of each history row. */
const HISTORY_VERB: Record<string, string> = {
  read: "read",
  write: "wrote",
  spawn: "ran",
  end: "done"
};

function emptyGraph(settings: BrainAtlasSettings): BrainGraph {
  return {
    nodes: [],
    edges: [],
    idx: {},
    adj: {},
    KIND_LABEL: {},
    activePalette: {
      label: settings.palette,
      bg: "#16151a",
      bgFar: "#0c0b0e",
      fg: "#e8e6e0",
      hud: "#c9b896",
      chroma: 0.4,
      kinds: {}
    },
    activePaletteName: settings.palette,
    CHAOS: { wobbleAmp: 0, wobbleSpeed: 0, halo: 0.6, bloom: 0.5, blob: 0, jitter: 1 }
  };
}

function lobeColor(lobe: LobeName, graph: BrainGraph): string {
  const kind = {
    frontal: "project",
    parietal: "concept",
    temporal: "person",
    occipital: "source",
    cerebellum: "dailyNote",
    stem: "index"
  }[lobe];
  return graph.activePalette.kinds[kind] ?? graph.activePalette.hud;
}

function lobeSubtitle(lobe: LobeName): string {
  switch (lobe) {
    case "frontal":
      return "Projects - Decisions";
    case "parietal":
      return "Concepts - Tools";
    case "temporal":
      return "People - Orgs";
    case "occipital":
      return "Sources - Repos";
    case "cerebellum":
      return "Daily - Incidents";
    case "stem":
      return "Index - Routing";
  }
}

function shortLobeLabel(lobe: LobeName): string {
  switch (lobe) {
    case "frontal":
      return "FRO";
    case "parietal":
      return "PAR";
    case "temporal":
      return "TEM";
    case "occipital":
      return "OCC";
    case "cerebellum":
      return "CER";
    case "stem":
      return "STM";
  }
}

function formatClassificationSource(source: BrainNode["classificationSource"]): string {
  switch (source) {
    case "frontmatter":
      return "frontmatter";
    case "tag":
      return "tag";
    case "folder":
      return "folder";
    case "filename":
      return "filename";
    case "linkBehavior":
      return "link behavior";
    case "default":
      return "default category";
  }
}
