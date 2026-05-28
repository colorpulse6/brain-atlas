import { BrainRenderer } from "../src/renderer.ts";
import { allLobesEnabled } from "../src/lobe-visibility.ts";
import { createDemoBrainGraph } from "./sample-graph.ts";

declare global {
  interface Window {
    brainAtlasDemoReady?: boolean;
  }
}

const canvas = document.querySelector<HTMLCanvasElement>("#brain-atlas-demo-canvas");
if (!canvas) throw new Error("Missing Brain Atlas demo canvas.");

const graph = createDemoBrainGraph();
const renderer = new BrainRenderer();

renderer.start(canvas, () => graph, {
  idleAutoRotate: true,
  showLobeLabels: true,
  enabledLobes: allLobesEnabled()
});

window.brainAtlasDemoReady = true;
