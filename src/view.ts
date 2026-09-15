import { App, ItemView, Platform, TFile, WorkspaceLeaf } from "obsidian";
import { buildGraph } from "./adapter.ts";
import { LOBES, setAllLobes, setLobeEnabled } from "./lobe-visibility.ts";
import { displayNodeName, displayNodePath } from "./node-display.ts";
import { BrainRenderer } from "./renderer.ts";
import { RenderCore, type BrainRendererOptions, type LiveScreenNode } from "./render-core.ts";
import { BrainGLRenderer } from "./gl/brain-gl-renderer.ts";
import type { ActivityState, LiveEntry } from "./activity.ts";
import { LOBE_CENTERS, liveNodePosition } from "./shape.ts";
import type { BrainAtlasSettings, PinnedNodePosition } from "./settings.ts";
import type { BrainGraph, BrainNode, LobeName } from "./types.ts";

export const BRAIN_ATLAS_VIEW_TYPE = "brain-atlas";

export interface BrainAtlasPluginHost {
  app: App;
  settings: BrainAtlasSettings;
  /** Shared live-activity state (null when the feature is off). */
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
  private taskPanelEl: HTMLDivElement | null = null;
  /** Signature of the last task-panel render, so we only rebuild it when the task set/status changes. */
  private taskPanelSig = "";
  /** View-local quick toggles (not persisted): dense node labels, and the task-manager panel. */
  private showAllLabels = false;
  private liveUiVisible = true;
  /** The vault-only graph (from buildGraph); live task/agent nodes are merged on top of it into this.graph. */
  private vaultGraph: BrainGraph | null = null;
  /** Signature of the live-node set currently merged into this.graph (re-merge only when it changes). */
  private mergedLiveSig = "";
  private infoButton: HTMLButtonElement | null = null;
  private labelButton: HTMLButtonElement | null = null;
  private namesButton: HTMLButtonElement | null = null;
  private spinButton: HTMLButtonElement | null = null;
  private tasksButton: HTMLButtonElement | null = null;
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
    this.taskPanelEl = root.createDiv({ cls: "brain-atlas-task-panel" });
    this.taskPanelEl.hide();
    this.emptyEl = root.createDiv({ cls: "brain-atlas-empty" });
    this.emptyEl.setText("Your brain is empty. Add notes with #project, #person, or #source tags to start mapping.");

    this.canvas.addEventListener("click", this.onCanvasClick);
    this.rebuild();
  }

  async onClose(): Promise<void> {
    this.canvas?.removeEventListener("click", this.onCanvasClick);
    this.renderer.stop();
    this.rendererStarted = false;
    this.taskPanelEl = null;
    this.taskPanelSig = "";
    this.rootEl = null;
    this.canvas = null;
    this.canvasContextKind = null;
    this.graph = null;
    this.vaultGraph = null;
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
    const sig = live.map((e) => `${e.id}:${e.active ? 1 : 0}:${e.kind}`).join("|");
    if (sig !== this.mergedLiveSig) this.composeGraph();
    this.renderer.requestFrame();
  }

  rebuild(): void {
    this.vaultGraph = buildGraph(this.plugin.app, this.plugin.settings);
    // Merge the live task/agent nodes on top so they render as REAL graph nodes; feeds activity.setGraph too.
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
      showAllLabels: this.showAllLabels,
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
   * The renderer hands us the current live nodes (what Claude is doing right now) each frame. The nodes
   * themselves render as REAL graph nodes (merged into the graph, see composeGraph); here we only (1) re-merge
   * when the set changes and (2) refresh the bottom-left task manager. No per-frame DOM work otherwise.
   */
  private syncLiveNodes(nodes: LiveScreenNode[]): void {
    const sig = nodes.map((n) => `${n.id}:${n.active ? 1 : 0}:${n.kind}`).join("|");
    if (sig !== this.mergedLiveSig) {
      this.composeGraph();
      this.renderer.requestFrame();
    }
    if (this.liveUiVisible) this.syncTaskPanel(nodes);
    else this.clearLiveUi();
  }

  /** A live task/agent as a real BrainNode: temporal-right for tasks, temporal-left (mirror) for agents. */
  private makeLiveNode(entry: LiveEntry): BrainNode {
    const side = entry.kind === "agent" ? "left" : "right";
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
      _3dLobe: liveNodePosition(entry.id, "temporal", side)
    };
  }

  /**
   * Merge the current live task/agent nodes on top of the vault graph so they render as real nodes (glow,
   * depth, hover). A NEW graph object is produced so the WebGL renderer rebuilds its buffers; live glow then
   * animates per-frame via the activity system with no further rebuild until the set changes.
   */
  private composeGraph(): void {
    const vault = this.vaultGraph;
    if (!vault) return;
    const live = this.plugin.activity?.liveNodes() ?? [];
    this.mergedLiveSig = live.map((e) => `${e.id}:${e.active ? 1 : 0}:${e.kind}`).join("|");
    if (live.length === 0) {
      this.graph = vault;
      this.plugin.activity?.setGraph(Object.keys(vault.idx), vault.adj);
      return;
    }
    const liveNodes = live.map((entry) => this.makeLiveNode(entry));
    const idx: Record<string, BrainNode> = { ...vault.idx };
    for (const node of liveNodes) idx[node.id] = node;
    this.graph = { ...vault, nodes: [...vault.nodes, ...liveNodes], idx, adj: vault.adj };
    this.plugin.activity?.setGraph(Object.keys(idx), vault.adj);
  }

  /** The bottom-left task manager: every live task grouped by kind (shells / commands / terminals / agents). */
  private syncTaskPanel(nodes: LiveScreenNode[]): void {
    const panel = this.taskPanelEl;
    if (!panel) return;
    if (nodes.length === 0) {
      if (this.taskPanelSig !== "") {
        panel.hide();
        panel.empty();
        this.taskPanelSig = "";
      }
      return;
    }
    // Only rebuild when the task set or their running/ending state changes (not every animation frame).
    const sig = nodes.map((n) => `${n.id}:${n.active ? 1 : 0}:${n.kind}`).join("|");
    if (sig === this.taskPanelSig) return;
    this.taskPanelSig = sig;
    panel.show();
    panel.empty();

    const active = nodes.filter((n) => n.active).length;
    const header = panel.createDiv({ cls: "brain-atlas-task-header" });
    header.createSpan({ cls: "brain-atlas-task-title", text: "ACTIVE" });
    header.createSpan({ cls: "brain-atlas-task-count", text: `${active} running` });

    const groups: Array<{ kind: string; title: string }> = [
      { kind: "shell", title: "Background shells" },
      { kind: "command", title: "Commands" },
      { kind: "terminal", title: "Terminals" },
      { kind: "agent", title: "Agents" }
    ];
    for (const group of groups) {
      const rows = nodes.filter((n) => n.kind === group.kind);
      if (rows.length === 0) continue;
      const section = panel.createDiv({ cls: "brain-atlas-task-group" });
      section.createDiv({ cls: "brain-atlas-task-group-title", text: `${group.title} — ${rows.length}` });
      for (const node of rows) {
        const row = section.createDiv({ cls: "brain-atlas-task-row" });
        row.toggleClass("is-ending", !node.active);
        row.setAttr("data-kind", node.kind);
        row.style.setProperty("--live-color", node.color);
        row.createSpan({ cls: "brain-atlas-task-dot" });
        const body = row.createDiv({ cls: "brain-atlas-task-body" });
        body.createSpan({ cls: "brain-atlas-task-name", text: node.label });
        if (node.detail && node.detail !== node.label) {
          body.createSpan({ cls: "brain-atlas-task-detail", text: node.detail });
        }
        row.createSpan({ cls: "brain-atlas-task-status", text: node.active ? "running" : "done" });
      }
    }
  }

  /** Hide the task-manager panel (the Tasks quick toggle is off). Live nodes stay in the brain. */
  private clearLiveUi(): void {
    if (this.taskPanelEl) {
      this.taskPanelEl.hide();
      this.taskPanelEl.empty();
    }
    this.taskPanelSig = "";
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
    this.labelButton = this.createControlButton(primary, "Sections", () => this.toggleLabels());
    this.namesButton = this.createControlButton(primary, "Names", () => this.toggleNames());
    this.spinButton = this.createControlButton(primary, "Spin", () => this.toggleSpin());
    this.tasksButton = this.createControlButton(primary, "Tasks", () => this.toggleTasks());
    this.createControlButton(primary, "Reset", () => this.renderer.resetView());

    const regionsRow = this.controlsEl.createDiv({ cls: "brain-atlas-control-group" });
    this.allButton = this.createControlButton(regionsRow, "All", () => this.setAllRegions(true));
    this.noneButton = this.createControlButton(regionsRow, "None", () => this.setAllRegions(false));

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
    this.namesButton?.toggleClass("is-active", this.showAllLabels);
    this.namesButton?.setAttr("aria-pressed", String(this.showAllLabels));
    this.spinButton?.toggleClass("is-active", this.plugin.settings.idleAutoRotate);
    this.spinButton?.setAttr("aria-pressed", String(this.plugin.settings.idleAutoRotate));
    this.tasksButton?.toggleClass("is-active", this.liveUiVisible);
    this.tasksButton?.setAttr("aria-pressed", String(this.liveUiVisible));
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

  private toggleInfo(): void {
    this.showInfo = !this.showInfo;
    this.syncOverlays();
  }

  /** Node-label density: minimal (in-use/hover/focus) vs all (dense hub labels). View-local. */
  private toggleNames(): void {
    this.showAllLabels = !this.showAllLabels;
    this.renderer.setOptions({ showAllLabels: this.showAllLabels });
    this.syncOverlays();
  }

  /** Idle auto-rotation on/off (persisted). */
  private toggleSpin(): void {
    this.plugin.settings.idleAutoRotate = !this.plugin.settings.idleAutoRotate;
    this.renderer.setOptions({ idleAutoRotate: this.plugin.settings.idleAutoRotate });
    this.syncOverlays();
    void this.persistViewSettings();
  }

  /** Show/hide the live task UI (reticle stack + bottom-left task manager). View-local. */
  private toggleTasks(): void {
    this.liveUiVisible = !this.liveUiVisible;
    if (!this.liveUiVisible) this.clearLiveUi();
    this.syncOverlays();
    this.renderer.requestFrame();
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
