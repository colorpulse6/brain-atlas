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

test.describe("WebGL haze matches Canvas2D", () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto(`file://${HARNESS_HTML}`);
    await page.waitForFunction(() => typeof window.renderFrame === "function");
  });

  test.afterAll(async () => {
    await page?.close();
  });

  // Test matrices: palettes × highlight cases.
  // Both background + haze are enabled so the A/B covers the full layered
  // composite (haze is additive on top of background).
  //
  // Tolerance rationale:
  //   Soft radial gradients with piecewise-linear alpha produce near-identical
  //   results across Canvas2D and WebGL when the coordinate/dpr math is correct.
  //   We allow < 0.3% of pixels (budget = ceil(w*h*0.003)) to account for
  //   sub-pixel AA rounding at gradient edges. A whole-region mismatch (e.g.
  //   wrong Y-flip, wrong dpr scaling, or wrong alpha formula) produces thousands
  //   of mismatches and is NOT tolerated — fix the shader, don't loosen this.
  const HAZE_CASES = [
    ...PALETTES.map((palette) => ({ palette, overrides: {} })),
    ...PALETTES.map((palette) => ({ palette, overrides: { highlightLobe: "frontal" } }))
  ];

  for (const { palette, overrides } of HAZE_CASES) {
    const caseName = [
      `palette=${palette}`,
      Object.entries(overrides)
        .map(([k, v]) => `${k}=${v}`)
        .join(",") || "base"
    ].join(" ");

    test(caseName, async () => {
      const base = {
        palette,
        rot: { x: -0.15, y: 0.55 },
        zoom: 1,
        dpr: 1,
        now: 1000,
        width: 480,
        height: 360,
        focusId: null,
        hoverId: null,
        highlightLobe: null,
        enabledPasses: ["background", "haze"],
        ...overrides
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

      // Budget: < 0.3% of pixels for soft-gradient AA/rounding differences.
      // Whole-region differences (wrong Y-flip, dpr, alpha formula) produce
      // thousands of mismatches and must be fixed in the shader.
      const budget = Math.ceil(width * height * 0.003);
      expect(
        mismatched,
        `${caseName}: ${mismatched} mismatched pixels (budget ${budget})`
      ).toBeLessThanOrEqual(budget);
    });
  }
});

test.describe("WebGL cloud matches Canvas2D", () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto(`file://${HARNESS_HTML}`);
    await page.waitForFunction(() => typeof window.renderFrame === "function");
  });

  test.afterAll(async () => {
    await page?.close();
  });

  // Cases: each palette at the default rotation, plus a rotated case (exercises
  // the far/near hemisphere split — the two cloud draw passes) and a highlight
  // case (exercises uLobeMul: highlighted lobe = 1, others = 0.16).
  // background + haze + cloud are all enabled so the A/B covers the full layered
  // composite the cloud accumulates onto.
  const CLOUD_CASES = [
    ...PALETTES.map((palette) => ({ palette, rot: { x: -0.15, y: 0.55 }, overrides: {} })),
    // Rotated camera: a different rot shifts which points fall on each side of
    // z = 0, exercising the FAR (z>0) and NEAR (z<=0) hemisphere passes.
    { palette: "graphite", rot: { x: 0.3, y: 1.2 }, overrides: {} },
    // Highlight: drives uLobeMul to 1 for "frontal", 0.16 for the rest.
    { palette: "graphite", rot: { x: -0.15, y: 0.55 }, overrides: { highlightLobe: "frontal" } }
  ];

  for (const { palette, rot, overrides } of CLOUD_CASES) {
    const caseName = [
      `palette=${palette}`,
      `rot=(${rot.x},${rot.y})`,
      Object.entries(overrides)
        .map(([k, v]) => `${k}=${v}`)
        .join(",") || "base"
    ].join(" ");

    test(caseName, async () => {
      const base = {
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
        enabledPasses: ["background", "haze", "cloud"],
        ...overrides
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

      // The cloud is ~1648 tiny additive dots (CSS radius 0.95 / 1.2). The WebGL
      // path approximates Canvas2D's sub-pixel arc()+fill with an analytic ~1
      // device-px coverage edge; on dots this small a handful of pixels can land
      // 1/255 apart at the AA boundary. Measured mismatches across these cases
      // are 0-18 px on a 480x360 (172800 px) frame — scattered, never regional;
      // daylight and the highlight case are an exact 0. Budget < 0.05% of pixels
      // (~86 px) leaves ~4.8x headroom over the worst case while still catching a
      // real bug (projection, far/near hemisphere selection, twinkle, coverage),
      // which would produce thousands of pixels / a whole half missing. Fix such
      // a regression — do NOT inflate this budget.
      const budget = Math.ceil(width * height * 0.0005);
      expect(
        mismatched,
        `${caseName}: ${mismatched} mismatched pixels (budget ${budget})`
      ).toBeLessThanOrEqual(budget);
    });
  }
});

test.describe("WebGL edges match Canvas2D", () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto(`file://${HARNESS_HTML}`);
    await page.waitForFunction(() => typeof window.renderFrame === "function");
  });

  test.afterAll(async () => {
    await page?.close();
  });

  // Cases exercise: palettes (lobe colors), a rotation that splits far/near (the
  // two sorted edge draws), focusId on a hub (focus alpha column + single-color
  // override) and hoverId on a node (hover alpha column).
  // background + haze + cloud + edges all enabled so the A/B covers the full
  // layered composite the edges blend onto (source-over translucent ribbons).
  const EDGE_CASES = [
    ...PALETTES.map((palette) => ({ palette, rot: { x: -0.15, y: 0.55 }, overrides: {} })),
    // Rotated camera splits which edges fall on each side of mean z = 0.
    { palette: "graphite", rot: { x: 0.3, y: 1.2 }, overrides: {} },
    // Focus on a hub: exercises the focus alpha column (0.55/0.85) and the
    // single-color edge.A.color override across the whole edge.
    { palette: "graphite", rot: { x: -0.15, y: 0.55 }, overrides: { focusId: FIXTURE_NODE_IDS.projectHub } },
    // Hover on a node: exercises the hover alpha column (0.25/0.40).
    { palette: "graphite", rot: { x: -0.15, y: 0.55 }, overrides: { hoverId: FIXTURE_NODE_IDS.nonHub } }
  ];

  for (const { palette, rot, overrides } of EDGE_CASES) {
    const caseName = [
      `palette=${palette}`,
      `rot=(${rot.x},${rot.y})`,
      Object.entries(overrides)
        .map(([k, v]) => `${k}=${v}`)
        .join(",") || "base"
    ].join(" ");

    test(caseName, async () => {
      const base = {
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
        enabledPasses: ["background", "haze", "cloud", "edges"],
        ...overrides
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

      // Edges are thousands of thin (0.55 / 0.7 / 1.3 CSS px) translucent ribbons.
      // The WebGL path reproduces Canvas2D's per-segment flat stair-step alpha and
      // sub-pixel lineWidth via an analytic centerline-coverage edge; on lines this
      // thin a scattering of pixels can land 1/255 apart at the AA boundary (same
      // class of difference as the cloud, but more lines → a larger count).
      // A LARGE or STRUCTURED diff (whole edges missing/mis-colored, wrong sort, or
      // focus edge not overriding color) would be thousands of pixels / regional and
      // is NOT tolerated — fix the shader/sort, do NOT inflate this budget.
      // Measured across these cases: 89-238 scattered px on a 480x360 (172800 px)
      // frame — 0.05%-0.14%, never regional; the focus case (wider 1.3px / brighter
      // ribbons → more AA boundary) is the worst. Budget < 0.25% of pixels (~432 px)
      // leaves ~1.8x headroom over the worst case while still catching a real bug
      // (projection, far/near split, sort order, focus/hover alpha, color override),
      // which produces thousands of px / whole edges. Fix such a regression — do NOT
      // inflate this budget.
      const budget = Math.ceil(width * height * 0.0025);
      expect(
        mismatched,
        `${caseName}: ${mismatched} mismatched pixels (budget ${budget})`
      ).toBeLessThanOrEqual(budget);
    });
  }
});

test.describe("WebGL nodes match Canvas2D", () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto(`file://${HARNESS_HTML}`);
    await page.waitForFunction(() => typeof window.renderFrame === "function");
  });

  test.afterAll(async () => {
    await page?.close();
  });

  // Cases exercise: palettes (lobe + node colors), a rotation that splits far/near
  // (the two sorted node draws), focusId on a hub (1.25 radius bump + that hub's
  // ring + crosshair) and hoverId on a non-hub node (1.18 bump). Archived/dormant
  // nodes are dimmed in every case (the fixture contains them — status 0.30/0.55).
  // background + haze + cloud + edges + nodes all enabled so the A/B covers the full
  // layered composite the nodes blend onto (source-over, in-fragment layered).
  const NODE_CASES = [
    ...PALETTES.map((palette) => ({ palette, rot: { x: -0.15, y: 0.55 }, overrides: {} })),
    // Rotated camera splits which nodes fall on each side of z = 0.
    { palette: "graphite", rot: { x: 0.3, y: 1.2 }, overrides: {} },
    // Focus on a hub: 1.25 radius bump; the focus node is a hub → ring + crosshair.
    { palette: "graphite", rot: { x: -0.15, y: 0.55 }, overrides: { focusId: FIXTURE_NODE_IDS.projectHub } },
    // Hover on a non-hub node: 1.18 radius bump.
    { palette: "graphite", rot: { x: -0.15, y: 0.55 }, overrides: { hoverId: FIXTURE_NODE_IDS.nonHub } }
  ];

  for (const { palette, rot, overrides } of NODE_CASES) {
    const caseName = [
      `palette=${palette}`,
      `rot=(${rot.x},${rot.y})`,
      Object.entries(overrides)
        .map(([k, v]) => `${k}=${v}`)
        .join(",") || "base"
    ].join(" ");

    test(caseName, async () => {
      const base = {
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
        enabledPasses: ["background", "haze", "cloud", "edges", "nodes"],
        ...overrides
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

      // Nodes are filled circles (halo + core + white dot) plus, for hubs, a thin
      // 0.8px ring + crosshair. The WebGL path composites these layers in-fragment
      // (premultiplied source-over, mathematically identical to Canvas2D's
      // sequential source-over draws) and approximates Canvas2D's sub-pixel
      // arc()/stroke() with a ~1 device-px analytic coverage edge. On filled
      // circles the AA boundary is a smaller fraction of node area than the cloud's
      // tiny dots, so the per-node scatter is low; hub rings/crosshairs add some
      // thin-stroke AA boundary. Measured across these cases: 21-107 scattered px
      // on a 480x360 (172800 px) frame — 0.01%-0.06%, never regional; the focus-hub
      // case (1.25x bump + ring + crosshair → most thin-stroke AA) is the worst.
      // A LARGE or STRUCTURED diff (missing halos, wrong dim, crosshair missing/wrong,
      // focus/hover bump absent, wrong sort) is thousands of px / regional and is NOT
      // tolerated — fix the shader/sort, do NOT inflate this budget. Budget < 0.15% of
      // pixels (~260 px) leaves ~2.4x headroom over the worst case while catching a bug.
      const budget = Math.ceil(width * height * 0.0015);
      expect(
        mismatched,
        `${caseName}: ${mismatched} mismatched pixels (budget ${budget})`
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
