import { App, ItemView, Platform, TFile, WorkspaceLeaf } from "obsidian";
import { buildGraph } from "./adapter.ts";
import { LOBES, setAllLobes, setLobeEnabled } from "./lobe-visibility.ts";
import { displayNodeName, displayNodePath } from "./node-display.ts";
import { BrainRenderer } from "./renderer.ts";
import { RenderCore, type BrainRendererOptions } from "./render-core.ts";
import { BrainGLRenderer } from "./gl/brain-gl-renderer.ts";
import { LOBE_CENTERS } from "./shape.ts";
import type { BrainAtlasSettings, PinnedNodePosition } from "./settings.ts";
import type { BrainGraph, BrainNode, LobeName } from "./types.ts";

export const BRAIN_ATLAS_VIEW_TYPE = "brain-atlas";

export interface BrainAtlasPluginHost {
  app: App;
  settings: BrainAtlasSettings;
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
  private infoButton: HTMLButtonElement | null = null;
  private labelButton: HTMLButtonElement | null = null;
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

    this.canvas.addEventListener("click", this.onCanvasClick);
    this.rebuild();
  }

  async onClose(): Promise<void> {
    this.canvas?.removeEventListener("click", this.onCanvasClick);
    this.renderer.stop();
    this.rendererStarted = false;
    this.rootEl = null;
    this.canvas = null;
    this.canvasContextKind = null;
    this.graph = null;
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

  rebuild(): void {
    this.graph = buildGraph(this.plugin.app, this.plugin.settings);
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
      enabledLobes: this.plugin.settings.enabledLobes,
      performancePreset: this.plugin.settings.performancePreset,
      mobileMode: this.isMobileRuntime(),
      onPinNode: (node, position) => this.pinNode(node, position),
      onChange: this.syncOverlays
    };
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

    const canvas = this.canvas!;

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
      try {
        fallback.start(canvas, getGraph, options);
        this.renderer = fallback;
        this.canvasContextKind = "2d";
        this.rendererStarted = true;
      } catch {
        // Canvas still tainted from a previous kind — recreate and retry once.
        this.recreateCanvas();
        try {
          fallback.start(this.canvas!, getGraph, options);
          this.renderer = fallback;
          this.canvasContextKind = "2d";
          this.rendererStarted = true;
        } catch {
          // Canvas2D start also failed; renderer stays stopped but view is intact.
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
    this.allButton = this.createControlButton(primary, "All", () => this.setAllRegions(true));
    this.noneButton = this.createControlButton(primary, "None", () => this.setAllRegions(false));

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
    this.plugin.app.workspace.getLeaf(this.plugin.settings.clickAction === "new-pane").openFile(file);
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
