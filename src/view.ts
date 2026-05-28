import { App, ItemView, TFile, WorkspaceLeaf } from "obsidian";
import { buildGraph } from "./adapter.ts";
import { LOBES, setAllLobes, setLobeEnabled } from "./lobe-visibility.ts";
import { BrainRenderer } from "./renderer.ts";
import { LOBE_CENTERS } from "./shape.ts";
import type { BrainAtlasSettings } from "./settings.ts";
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
  private renderer = new BrainRenderer();
  private graph: BrainGraph | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private controlsEl: HTMLDivElement | null = null;
  private legendEl: HTMLDivElement | null = null;
  private tooltipEl: HTMLDivElement | null = null;
  private focusEl: HTMLDivElement | null = null;
  private emptyEl: HTMLDivElement | null = null;
  private labelButton: HTMLButtonElement | null = null;
  private allButton: HTMLButtonElement | null = null;
  private noneButton: HTMLButtonElement | null = null;
  private lobeButtons: Partial<Record<LobeName, HTMLButtonElement>> = {};

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
    this.canvas = root.createEl("canvas", { cls: "brain-atlas-canvas" });
    this.createHud(root);
    this.createControls(root);
    this.legendEl = root.createDiv({ cls: "brain-atlas-legend" });
    this.tooltipEl = root.createDiv({ cls: "brain-atlas-tooltip" });
    this.focusEl = root.createDiv({ cls: "brain-atlas-focus-card" });
    this.emptyEl = root.createDiv({ cls: "brain-atlas-empty" });
    this.emptyEl.setText("Your brain is empty. Add notes with #project, #person, or #source tags to start mapping.");

    this.canvas.addEventListener("click", this.onCanvasClick);
    this.rebuild();
    this.renderer.start(this.canvas, () => this.graph ?? emptyGraph(this.plugin.settings), {
      idleAutoRotate: this.plugin.settings.idleAutoRotate,
      showLobeLabels: this.plugin.settings.showLobeLabels,
      enabledLobes: this.plugin.settings.enabledLobes,
      onChange: this.syncOverlays
    });
  }

  async onClose(): Promise<void> {
    this.canvas?.removeEventListener("click", this.onCanvasClick);
    this.renderer.stop();
    this.graph = null;
  }

  onShow(): void {
    if (this.canvas && this.graph) {
      this.renderer.start(this.canvas, () => this.graph ?? emptyGraph(this.plugin.settings), {
        idleAutoRotate: this.plugin.settings.idleAutoRotate,
        showLobeLabels: this.plugin.settings.showLobeLabels,
        enabledLobes: this.plugin.settings.enabledLobes,
        onChange: this.syncOverlays
      });
    }
  }

  onHide(): void {
    this.renderer.stop();
  }

  rebuild(): void {
    this.graph = buildGraph(this.plugin.app, this.plugin.settings);
    this.renderer.setOptions({
      idleAutoRotate: this.plugin.settings.idleAutoRotate,
      showLobeLabels: this.plugin.settings.showLobeLabels,
      enabledLobes: this.plugin.settings.enabledLobes,
      onChange: this.syncOverlays
    });
    this.syncOverlays();
  }

  private createHud(root: HTMLElement): void {
    const hud = root.createDiv({ cls: "brain-atlas-hud" });
    hud.createSpan({ cls: "brain-atlas-pulse" });
    hud.createSpan({ text: "LOBE - ATLAS - v2" });
    hud.createSpan({ cls: "brain-atlas-muted", text: " -" });
    hud.createSpan({ text: " 6 regions" });

    const help = root.createDiv({ cls: "brain-atlas-help" });
    help.setText("DRAG - rotate   -   SCROLL - zoom");
  }

  private createControls(root: HTMLElement): void {
    this.controlsEl = root.createDiv({ cls: "brain-atlas-controls" });
    const primary = this.controlsEl.createDiv({ cls: "brain-atlas-control-group" });
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
    this.syncTooltip();
    this.syncFocusCard();
    this.emptyEl?.toggleClass("is-visible", graph.nodes.length === 0);
  };

  private syncControls(): void {
    const enabled = this.plugin.settings.enabledLobes;
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
    this.tooltipEl.createDiv({ cls: "brain-atlas-tooltip-title", text: node.name });
    this.tooltipEl.createDiv({ cls: "brain-atlas-tooltip-sub", text: `${node.kindLabel} - degree ${node.degree}` });
  }

  private syncFocusCard(): void {
    if (!this.focusEl) return;
    const node = this.renderer.getFocusedNode();
    this.focusEl.toggleClass("is-visible", !!node);
    if (!node) return;
    this.focusEl.empty();
    this.focusEl.createDiv({ cls: "brain-atlas-focus-meta", text: `${node.kindLabel} - ${node.status.toUpperCase()}` });
    this.focusEl.createDiv({ cls: "brain-atlas-focus-title", text: node.name });
    this.focusEl.createDiv({ cls: "brain-atlas-focus-sub", text: `${node.degree} links` });
  }

  private onCanvasClick = (event: MouseEvent): void => {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.renderer.hitTest(event.clientX - rect.left, event.clientY - rect.top);
    if (!hit) return;
    this.openNode(hit);
  };

  private openNode(node: BrainNode): void {
    const file = this.plugin.app.vault.getAbstractFileByPath(node.id);
    if (!(file instanceof TFile)) return;
    this.plugin.app.workspace.getLeaf(this.plugin.settings.clickAction === "new-pane").openFile(file);
  }

  private toggleLabels(): void {
    this.plugin.settings.showLobeLabels = !this.plugin.settings.showLobeLabels;
    this.renderer.setOptions({ showLobeLabels: this.plugin.settings.showLobeLabels });
    this.syncOverlays();
    void this.persistViewSettings();
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
