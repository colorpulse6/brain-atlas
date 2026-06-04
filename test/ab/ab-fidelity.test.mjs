/**
 * A/B pixel-diff self-check: render the Canvas2D renderer twice with identical
 * configuration and assert 0 mismatched pixels via pixelmatch.
 *
 * This proves the harness is deterministic. The WebGL renderer comparison
 * will be wired in a later task.
 */

import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { fileURLToPath } from "url";
import path from "path";
import { Buffer } from "buffer";
import assert from "assert";
import { FIXTURE_NODE_IDS } from "./fixture-ids.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_HTML = path.join(__dirname, "harness.html");

const PALETTES = ["graphite", "daylight", "magma"];

const ROTS = [
  { x: -0.15, y: 0.55 },
  { x: 0.3, y: 1.2 }
];

const CASE_OVERRIDES = [
  {},
  { highlightLobe: "frontal" },
  { focusId: FIXTURE_NODE_IDS.projectHub },
  { hoverId: FIXTURE_NODE_IDS.nonHub }
];

/**
 * Decode a PNG data URL into a pngjs PNG object.
 * @param {string} dataUrl
 * @returns {PNG}
 */
function decodePng(dataUrl) {
  const base64 = dataUrl.split(",")[1];
  const buf = Buffer.from(base64, "base64");
  return PNG.sync.read(buf);
}

/**
 * Decode two PNG data URLs and return the pixelmatch mismatch count.
 * @param {string} dataUrlA
 * @param {string} dataUrlB
 * @returns {{ mismatched: number }}
 */
function diffPng(dataUrlA, dataUrlB) {
  const imgA = decodePng(dataUrlA);
  const imgB = decodePng(dataUrlB);
  const { width, height } = imgA;
  const mismatched = pixelmatch(imgA.data, imgB.data, null, width, height, { threshold: 0.1 });
  return { mismatched };
}

/**
 * Call window.renderFrame(cfg) in the page and return the PNG data URL.
 * @param {import("@playwright/test").Page} page
 * @param {object} cfg
 * @returns {Promise<string>}
 */
async function renderFrame(page, cfg) {
  return page.evaluate((c) => window.renderFrame(c), cfg);
}

test.describe("Canvas2D self-check (0 pixel diff)", () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto(`file://${HARNESS_HTML}`);
    // Wait for the harness bundle to attach window.renderFrame.
    await page.waitForFunction(() => typeof window.renderFrame === "function");
  });

  test.afterAll(async () => {
    await page?.close();
  });

  for (const palette of PALETTES) {
    for (const rot of ROTS) {
      for (const overrides of CASE_OVERRIDES) {
        const caseName = [
          `palette=${palette}`,
          `rot=(${rot.x},${rot.y})`,
          Object.entries(overrides)
            .map(([k, v]) => `${k}=${v}`)
            .join(",") || "base"
        ].join(" ");

        test(caseName, async () => {
          const cfg = {
            renderer: "canvas2d",
            palette,
            rot,
            zoom: 1,
            dpr: 1,
            now: 1000,
            width: 480,
            height: 360,
            focusId: null,
            hoverId: null,
            highlightLobe: null,
            ...overrides
          };

          // Render twice with identical cfg.
          const urlA = await renderFrame(page, cfg);
          const urlB = await renderFrame(page, cfg);

          expect(urlA).toBeTruthy();
          expect(urlB).toBeTruthy();

          const imgA = decodePng(urlA);
          const imgB = decodePng(urlB);

          expect(imgA.width).toBe(imgB.width);
          expect(imgA.height).toBe(imgB.height);

          const { width, height } = imgA;
          const mismatch = pixelmatch(
            imgA.data,
            imgB.data,
            null,
            width,
            height,
            { threshold: 0.1 }
          );

          expect(mismatch, `${caseName}: expected 0 mismatched pixels, got ${mismatch}`).toBe(0);
        });
      }
    }
  }
});

test.describe("WebGL background matches Canvas2D", () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto(`file://${HARNESS_HTML}`);
    await page.waitForFunction(() => typeof window.renderFrame === "function");
  });

  test.afterAll(async () => {
    await page?.close();
  });

  const BG_CASES = [
    ...PALETTES.map((palette) => ({ palette, dpr: 1 })),
    // dpr:2 case exercises the gl_FragCoord.y / uDpr Y-flip path at non-trivial dpr.
    { palette: "graphite", dpr: 2 }
  ];

  for (const { palette, dpr } of BG_CASES) {
    test(`palette=${palette} dpr=${dpr} background pass`, async () => {
      const base = {
        palette,
        rot: { x: 0.3, y: 1.2 },
        zoom: 1.2,
        dpr,
        now: 1000,
        width: 480,
        height: 360,
        focusId: null,
        hoverId: null,
        highlightLobe: null,
        enabledPasses: ["background"]
      };

      const urlCanvas = await renderFrame(page, { ...base, renderer: "canvas2d" });
      const urlGl = await renderFrame(page, { ...base, renderer: "webgl2" });

      expect(urlCanvas).toBeTruthy();
      expect(urlGl).toBeTruthy();

      const imgA = decodePng(urlCanvas);
      const imgB = decodePng(urlGl);
      expect(imgA.width).toBe(imgB.width);
      expect(imgA.height).toBe(imgB.height);

      const { width, height } = imgA;
      const mismatched = pixelmatch(imgA.data, imgB.data, null, width, height, { threshold: 0.1 });

      // The radial gradient is a smooth field; a handful of pixels along the
      // bg->bgFar interpolation band can differ by 1/255 due to GPU float
      // rounding vs Canvas2D's gradient rasterizer. We allow a tiny budget
      // (< 0.2% of pixels). A large diff (whole regions) would indicate a real
      // fidelity bug (Y-flip, dpr conversion, or stop interpolation) and is NOT
      // tolerated — fix the shader, don't loosen this.
      const budget = Math.ceil(width * height * 0.002);
      expect(
        mismatched,
        `palette=${palette} dpr=${dpr}: ${mismatched} mismatched pixels (budget ${budget})`
      ).toBeLessThanOrEqual(budget);
    });
  }
});

test.describe("Canvas2D reactivity check", () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto(`file://${HARNESS_HTML}`);
    await page.waitForFunction(() => typeof window.renderFrame === "function");
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test("different configs produce a non-zero diff (harness renders real, state-reactive content)", async () => {
    const cfg = { renderer: "canvas2d", palette: "graphite", rot: { x: -0.15, y: 0.55 }, zoom: 1, dpr: 1, now: 1000, width: 480, height: 360 };
    const base = await renderFrame(page, cfg);
    const highlighted = await renderFrame(page, { ...cfg, highlightLobe: "frontal" });
    const { mismatched } = diffPng(base, highlighted);
    assert.ok(mismatched > 50, `expected base vs highlight to differ, got ${mismatched} mismatched pixels`);
  });
});
