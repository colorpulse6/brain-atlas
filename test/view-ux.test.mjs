import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viewSource = readFileSync(new URL("../src/view.ts", import.meta.url), "utf8");
const rendererSource = readFileSync(new URL("../src/renderer.ts", import.meta.url), "utf8");
const coreSource = readFileSync(new URL("../src/render-core.ts", import.meta.url), "utf8");
const settingsTabSource = readFileSync(new URL("../src/settings-tab.ts", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
// Label/compass logic was extracted to the shared overlay module (Task 12).
const overlayLabelsSource = readFileSync(new URL("../src/overlay-labels.ts", import.meta.url), "utf8");
const glRendererSource = readFileSync(new URL("../src/gl/brain-gl-renderer.ts", import.meta.url), "utf8");

test("the view explains how notes, links, and regions are derived", () => {
  assert.match(viewSource, /brain-atlas-info-panel/);
  assert.match(viewSource, /wikilinks and embeds/);
  assert.match(viewSource, /frontmatter/);
  assert.match(viewSource, /tags/);
  assert.match(viewSource, /folders/);
});

test("tooltip, focus card, and canvas labels use display-safe names", () => {
  assert.match(viewSource, /displayNodeName/);
  // displayNodeName was extracted from renderer.ts into the shared overlay-labels
  // module (Task 12). renderer.ts delegates to it via sharedDrawNodeLabels.
  assert.match(overlayLabelsSource, /displayNodeName/);
});

test("mobile layout has narrow-pane controls and overlays", () => {
  assert.match(stylesSource, /@media only screen and \(max-width: 700px\)/);
  assert.match(stylesSource, /\.brain-atlas-controls/);
  assert.match(stylesSource, /\.brain-atlas-info-panel/);
});

test("coarse pointer taps can preview a node before opening it", () => {
  assert.match(viewSource, /pointer: coarse/);
  assert.match(viewSource, /pendingOpenNodeId/);
  assert.match(viewSource, /Tap again to open/);
});

test("renderer supports dragging nodes into persisted pins without opening after drag", () => {
  assert.match(coreSource, /onPinNode/);
  assert.match(coreSource, /mode: "node"/);
  assert.match(coreSource, /consumeSuppressedClick/);
  assert.match(viewSource, /DRAG NODE - pin/);
  assert.match(viewSource, /pinNode/);
});

test("view surfaces classification source and categorization settings", () => {
  assert.match(viewSource, /classificationSource/);
  assert.match(viewSource, /classified by/);
  assert.match(settingsTabSource, /Default category/);
  assert.match(settingsTabSource, /Tag mappings/);
  assert.match(settingsTabSource, /Folder mappings/);
  assert.match(settingsTabSource, /Region overrides/);
  assert.match(settingsTabSource, /Tag region mappings/);
  assert.match(settingsTabSource, /Note region mappings/);
  assert.match(settingsTabSource, /brain_region, lobe, region/);
  assert.match(settingsTabSource, /client=temporal/);
  assert.match(settingsTabSource, /Projects\/Big Idea\.md=frontal/);
  assert.match(settingsTabSource, /Valid regions: frontal, parietal, temporal, occipital, cerebellum, stem/);
});

test("plugin view is contained and stops scroll events from leaking into Obsidian chrome", () => {
  assert.match(stylesSource, /contain:\s*strict/);
  assert.match(stylesSource, /overscroll-behavior:\s*contain/);
  assert.match(coreSource, /event\.stopPropagation\(\)/);
});

test("settings expose light mode and opt-in performance presets", () => {
  assert.match(settingsTabSource, /Performance preset/);
  assert.match(settingsTabSource, /Smooth \(current\)/);
  assert.match(settingsTabSource, /Mobile/);
  assert.match(settingsTabSource, /Battery saver/);
  assert.match(viewSource, /Platform/);
  assert.match(viewSource, /mobileMode/);
  assert.match(viewSource, /performancePreset/);
  assert.match(stylesSource, /is-light-palette/);
});

test("README sets mobile support expectations and points users to the mobile preset", () => {
  const readmeSource = readFileSync(new URL("../README.md", import.meta.url), "utf8");

  assert.match(readmeSource, /designed primarily for desktop Obsidian/i);
  assert.match(readmeSource, /Mobile support is experimental/i);
  assert.match(readmeSource, /Mobile preset/i);
});

test("settings expose frontmatter value mappings and a classification report", () => {
  assert.match(settingsTabSource, /Frontmatter value mappings/);
  assert.match(settingsTabSource, /type:wiki=source/);
  assert.match(settingsTabSource, /Frontmatter region value mappings/);
  assert.match(settingsTabSource, /type:wiki=occipital/);
  assert.match(settingsTabSource, /Folder region mappings/);
  assert.match(settingsTabSource, /Classification report/);
  assert.match(settingsTabSource, /Unmapped frontmatter values/);
});

test("view selects WebGL2 renderer on desktop with Canvas2D fallback", () => {
  // view imports BrainGLRenderer
  assert.match(viewSource, /BrainGLRenderer/);
  // renderer field is typed as RenderCore (the abstract base)
  assert.match(viewSource, /RenderCore/);
  // rendererMode setting is referenced for selection logic
  assert.match(viewSource, /rendererMode/);
  // startRenderer method exists and calls selectRenderer
  assert.match(viewSource, /startRenderer/);
  assert.match(viewSource, /selectRenderer/);
  // fallback try/catch: Canvas2D fallback when WebGL fails
  assert.match(viewSource, /fallback/);
  // interaction target uses the clean getInteractionTarget() accessor
  assert.match(viewSource, /getInteractionTarget/);
  // canvas2d mode forces Canvas2D
  assert.match(viewSource, /canvas2d/);
  // mobile check feeds renderer selection
  assert.match(viewSource, /isMobileRuntime/);
});

test("canvas is recreated when renderer kind changes to avoid locked context", () => {
  // canvasContextKind tracks the context kind successfully bound to this.canvas
  assert.match(viewSource, /canvasContextKind/);
  // recreateCanvas replaces the DOM canvas element and resets the kind
  assert.match(viewSource, /recreateCanvas/);
  // rendererStarted guards start-vs-setOptions in rebuild()
  assert.match(viewSource, /rendererStarted/);
  // desiredKind is derived from the selected renderer type
  assert.match(viewSource, /desiredKind/);
  // recreation only happens when kinds differ (not on same-kind restart)
  assert.match(viewSource, /canvasContextKind !== desiredKind/);
  // fresh canvas is prepended so it stays under the HUD/controls in DOM order
  assert.match(viewSource, /prepend/);
});

test("renderer options are factored into a single rendererOptions() helper", () => {
  // The DRY helper must exist in view.ts
  assert.match(viewSource, /rendererOptions/);
  // onOpen/onShow no longer duplicate the options object inline
  // (startRenderer() is called instead of inline .start(...) with raw options)
  assert.match(viewSource, /startRenderer\(\)/);
});

test("WebGL2 renderer overlay is pointer-transparent and sits above the WebGL canvas", () => {
  // overlay is pointer-events:none so clicks fall through to the WebGL canvas
  assert.match(glRendererSource, /pointerEvents.*none|pointer-events.*none/);
  // overlay is absolutely positioned to cover the WebGL canvas
  assert.match(glRendererSource, /position.*absolute|absolute.*position/);
  // .brain-atlas-root is position:relative so absolute children are contained
  assert.match(stylesSource, /\.brain-atlas-root[\s\S]*?position:\s*relative/);
});
