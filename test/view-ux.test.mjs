import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viewSource = readFileSync(new URL("../src/view.ts", import.meta.url), "utf8");
const rendererSource = readFileSync(new URL("../src/renderer.ts", import.meta.url), "utf8");
const settingsTabSource = readFileSync(new URL("../src/settings-tab.ts", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("the view explains how notes, links, and regions are derived", () => {
  assert.match(viewSource, /brain-atlas-info-panel/);
  assert.match(viewSource, /wikilinks and embeds/);
  assert.match(viewSource, /frontmatter/);
  assert.match(viewSource, /tags/);
  assert.match(viewSource, /folders/);
});

test("tooltip, focus card, and canvas labels use display-safe names", () => {
  assert.match(viewSource, /displayNodeName/);
  assert.match(rendererSource, /displayNodeName/);
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
  assert.match(rendererSource, /onPinNode/);
  assert.match(rendererSource, /mode: "node"/);
  assert.match(rendererSource, /consumeSuppressedClick/);
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
  assert.match(rendererSource, /event\.stopPropagation\(\)/);
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
