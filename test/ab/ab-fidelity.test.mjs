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

test.describe("WebGL signals match Canvas2D", () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto(`file://${HARNESS_HTML}`);
    await page.waitForFunction(() => typeof window.renderFrame === "function");
  });

  test.afterAll(async () => {
    await page?.close();
  });

  // Three fixed signals between known fixture nodes across different lobes.
  // born=0, dur=2000, now=1000 → tNorm=0.5 → envelope=sin(π/2)=1 (max intensity).
  // colA/colB use the default palette node colors (resolved from graph in harness).
  const FIXED_SIGNALS = [
    // frontal hub → temporal hub (inter-lobe)
    { aId: FIXTURE_NODE_IDS.projectHub, bId: FIXTURE_NODE_IDS.personHub, born: 0, dur: 2000 },
    // parietal hub → occipital hub
    { aId: FIXTURE_NODE_IDS.conceptHub, bId: FIXTURE_NODE_IDS.sourceHub, born: 0, dur: 2000 },
    // cerebellum hub → stem hub
    { aId: FIXTURE_NODE_IDS.dailyHub, bId: FIXTURE_NODE_IDS.indexHub, born: 0, dur: 2000 }
  ];

  // Cases: each palette + one highlighted-lobe case.
  const SIGNAL_CASES = [
    ...PALETTES.map((palette) => ({ palette, overrides: {} })),
    { palette: "graphite", overrides: { highlightLobe: "frontal" } }
  ];

  for (const { palette, overrides } of SIGNAL_CASES) {
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
        enabledPasses: ["background", "haze", "cloud", "edges", "nodes", "signals"],
        signals: FIXED_SIGNALS,
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

      // Signal sprites are soft additive radial halos + analytic filled circles.
      // The halo is a radial falloff (1-t) which Canvas2D renders as a radial
      // gradient (continuous) while WebGL computes it per-fragment analytically —
      // both are identical in math, but GPU float rounding at sub-pixel edges
      // produces ~1/255 scattered differences. Budget < 0.4% of pixels (~692 px)
      // catches regional bugs (wrong Bézier, wrong color lerp, wrong additive sum,
      // wrong position) which produce thousands of mismatched pixels.
      const budget = Math.ceil(width * height * 0.004);
      expect(
        mismatched,
        `${caseName}: ${mismatched} mismatched pixels (budget ${budget})`
      ).toBeLessThanOrEqual(budget);
    });
  }
});

test.describe("WebGL full geometry matches Canvas2D", () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto(`file://${HARNESS_HTML}`);
    await page.waitForFunction(() => typeof window.renderFrame === "function");
  });

  test.afterAll(async () => {
    await page?.close();
  });

  // Combined all-geometry comparison: background + haze + cloud + edges + nodes + signals.
  // Labels and compass are excluded (Task 12 overlay). This is the milestone gate
  // verifying all geometry passes composite correctly together.
  const FIXED_SIGNALS = [
    { aId: FIXTURE_NODE_IDS.projectHub, bId: FIXTURE_NODE_IDS.personHub, born: 0, dur: 2000 },
    { aId: FIXTURE_NODE_IDS.conceptHub, bId: FIXTURE_NODE_IDS.sourceHub, born: 0, dur: 2000 },
    { aId: FIXTURE_NODE_IDS.dailyHub, bId: FIXTURE_NODE_IDS.indexHub, born: 0, dur: 2000 }
  ];

  const ALL_PASSES = ["background", "haze", "cloud", "edges", "nodes", "signals"];

  const COMBINED_CASES = [
    // Each palette at the default rotation (lobe color coverage).
    ...PALETTES.map((palette) => ({
      label: `palette=${palette} base`,
      overrides: { palette }
    })),
    // Rotated camera: exercises far/near hemisphere compositing for cloud, edges, nodes.
    {
      label: "palette=graphite rot=(0.3,1.2)",
      overrides: { palette: "graphite", rot: { x: 0.3, y: 1.2 } }
    },
    // Focus on a hub: exercises focus edge + node radius bump.
    {
      label: "palette=graphite focusId=projectHub",
      overrides: { palette: "graphite", focusId: FIXTURE_NODE_IDS.projectHub }
    },
    // Injected signals + highlighted lobe: exercises signal regionAlpha via lobeMul.
    {
      label: "palette=graphite highlightLobe=frontal signals",
      overrides: { palette: "graphite", highlightLobe: "frontal" }
    }
  ];

  for (const { label, overrides } of COMBINED_CASES) {
    test(label, async () => {
      const base = {
        rot: { x: -0.15, y: 0.55 },
        zoom: 1,
        dpr: 1,
        now: 1000,
        width: 480,
        height: 360,
        focusId: null,
        hoverId: null,
        highlightLobe: null,
        enabledPasses: ALL_PASSES,
        signals: FIXED_SIGNALS,
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

      // Combined all-geometry budget: the union of per-pass AA/rounding budgets.
      // Background (0.2%) + haze (0.3%) + cloud (0.05%) + edges (0.25%) +
      // nodes (0.15%) + signals (0.4%) — but passes partially cancel (shared
      // area is not double-counted). A structural compositing bug (wrong blend
      // mode, wrong draw order, additive vs source-over swap) produces thousands
      // of mismatched pixels and is NOT tolerated — fix it, don't loosen this.
      // Budget: < 0.5% of pixels (~864 px).
      const budget = Math.ceil(width * height * 0.005);
      expect(
        mismatched,
        `${label}: ${mismatched} mismatched pixels (budget ${budget})`
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

test.describe("WebGL full scene (geometry + labels + compass) matches Canvas2D", () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto(`file://${HARNESS_HTML}`);
    await page.waitForFunction(() => typeof window.renderFrame === "function");
  });

  test.afterAll(async () => {
    await page?.close();
  });

  // Three fixed signals for deterministic rendering.
  const FIXED_SIGNALS = [
    { aId: FIXTURE_NODE_IDS.projectHub, bId: FIXTURE_NODE_IDS.personHub, born: 0, dur: 2000 },
    { aId: FIXTURE_NODE_IDS.conceptHub, bId: FIXTURE_NODE_IDS.sourceHub, born: 0, dur: 2000 },
    { aId: FIXTURE_NODE_IDS.dailyHub, bId: FIXTURE_NODE_IDS.indexHub, born: 0, dur: 2000 }
  ];

  // Full scene: all passes including labels + compass. enabledPasses=null (or omit) → all passes.
  // Both renderers use showLobeLabels:true (harness default).
  //
  // Cases:
  //   1. Each palette at the default rotation (exercises label lobe color paths).
  //   2. Rotated camera (exercises hemisphere split for geometry + compass orientation change).
  //   3. Focus on a hub (shows neighbor labels via focusId branch in drawNodeLabels).
  //   4. showLobeLabels:false — no labels in either renderer; confirms suppression.
  //
  // Tolerance rationale:
  //   Full-scene budget = all-geometry budget (< 0.5%) + label/compass text.
  //   Labels are crisp monospace text drawn identically on the SAME headless Chromium
  //   Canvas2D context by both renderers (Canvas2D directly; WebGL via the overlay
  //   Canvas2D). If font fallback occurs it does so identically → zero label diff.
  //   The compass uses the same draw calls. A few extra scattered text AA pixels are
  //   expected; a structured diff (labels offset, missing, wrong color, compass wrong)
  //   is a BUG and must be fixed.
  //   Budget: < 0.6% of pixels (~1036 px on 480×360) — 0.5% geometry + 0.1% text AA.

  const FULL_SCENE_CASES = [
    // Palette coverage with all-default rotation and showLobeLabels:true.
    ...PALETTES.map((palette) => ({
      label: `palette=${palette} full-scene`,
      overrides: { palette, signals: FIXED_SIGNALS }
    })),
    // Rotated camera: changes compass orientation + hemisphere split.
    {
      label: "palette=graphite rot=(0.3,1.2) full-scene",
      overrides: { palette: "graphite", rot: { x: 0.3, y: 1.2 }, signals: FIXED_SIGNALS }
    },
    // Focus on hub: exercises the focusId neighbor-label branch.
    {
      label: "palette=graphite focusId=projectHub full-scene",
      overrides: {
        palette: "graphite",
        focusId: FIXTURE_NODE_IDS.projectHub,
        signals: FIXED_SIGNALS
      }
    },
    // showLobeLabels:false — labels + compass still enabled but showLobeLabels suppresses
    // lobe+node labels; only compass is drawn. Both renderers respect the same flag.
    {
      label: "palette=graphite showLobeLabels=false full-scene",
      overrides: {
        palette: "graphite",
        showLobeLabels: false,
        signals: FIXED_SIGNALS
      }
    }
  ];

  for (const { label, overrides } of FULL_SCENE_CASES) {
    test(label, async () => {
      const base = {
        rot: { x: -0.15, y: 0.55 },
        zoom: 1,
        dpr: 1,
        now: 1000,
        width: 480,
        height: 360,
        focusId: null,
        hoverId: null,
        highlightLobe: null,
        // enabledPasses omitted → all passes (geometry + labels + compass).
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

      // Budget: < 0.6% of pixels — 0.5% all-geometry (background+haze+cloud+edges+nodes+signals)
      // + 0.1% for text AA (lobe labels, node labels, compass glyphs drawn via the SAME
      // Canvas2D engine in both renderers, so should be near-zero but allow for compositing
      // order differences). A STRUCTURED diff (labels offset, missing lobe labels, compass wrong
      // orientation, labels on wrong renderer only) produces thousands of mismatched pixels and
      // is NOT tolerated — fix the code, do NOT inflate this budget.
      const budget = Math.ceil(width * height * 0.006);
      expect(
        mismatched,
        `${label}: ${mismatched} mismatched pixels (budget ${budget})`
      ).toBeLessThanOrEqual(budget);
    });
  }
});

test.describe("WebGL full scene showLobeLabels=false — labels absent on both renderers", () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto(`file://${HARNESS_HTML}`);
    await page.waitForFunction(() => typeof window.renderFrame === "function");
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test("showLobeLabels=false: WebGL output matches Canvas2D (no labels, compass present)", async () => {
    const base = {
      palette: "graphite",
      rot: { x: -0.15, y: 0.55 },
      zoom: 1,
      dpr: 1,
      now: 1000,
      width: 480,
      height: 360,
      focusId: null,
      hoverId: null,
      highlightLobe: null,
      showLobeLabels: false
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

    // Same geometry budget as all-passes test but no label AA scatter expected.
    // Compass (always drawn) may add a few scattered text-glyph AA pixels.
    const budget = Math.ceil(width * height * 0.006);
    expect(
      mismatched,
      `showLobeLabels=false: ${mismatched} mismatched pixels (budget ${budget})`
    ).toBeLessThanOrEqual(budget);
  });
});

test.describe("WebGL drag partial-update matches full render", () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto(`file://${HARNESS_HTML}`);
    await page.waitForFunction(() => typeof window.renderFrame === "function");
  });

  test.afterAll(async () => {
    await page?.close();
  });

  // The dragged node + its incident edges must follow the drag in WebGL via a
  // PARTIAL bufferSubData (onNodeMoved), producing the SAME image a full rebuild
  // at the moved position produces. We render the WebGL renderer two ways and
  // assert pixel-identity (within the established node+edge AA budget; partial
  // and full use the SAME computeEdgePositionBlock so the geometry is byte-equal):
  //   Path A (full build): node _3dLobe is set to the MOVED position BEFORE start,
  //     so the initial static buffer build already includes it (presetPositions).
  //   Path B (partial update): node starts at its ORIGINAL position; after an
  //     initial render builds the static buffers, moveNodeForTest applies the move,
  //     firing onNodeMoved → partial node + incident-edge bufferSubData (moves).
  //
  // We test a HUB (22 incident edges — exercises the incident-edge map at scale)
  // and a NON-HUB (3 incident edges). edges + nodes passes both enabled so both
  // the moved node sprite AND its incident edge ribbons are compared.
  const DRAG_CASES = [
    {
      label: "hub (projectHub, 22 incident edges)",
      id: FIXTURE_NODE_IDS.projectHub,
      moved: { x: 0.30, y: 0.05, z: 0.50 }
    },
    {
      label: "non-hub (nonHub, 3 incident edges)",
      id: FIXTURE_NODE_IDS.nonHub,
      moved: { x: 0.25, y: 0.40, z: 0.10 }
    }
  ];

  for (const { label, id, moved } of DRAG_CASES) {
    test(`${label}: partial update == full build`, async () => {
      const base = {
        renderer: "webgl2",
        palette: "graphite",
        rot: { x: -0.15, y: 0.55 },
        zoom: 1,
        dpr: 1,
        now: 1000,
        width: 480,
        height: 360,
        focusId: null,
        hoverId: null,
        highlightLobe: null,
        enabledPasses: ["background", "haze", "cloud", "edges", "nodes"]
      };

      // Path A: full build with the node already at the moved position.
      const urlFull = await renderFrame(page, {
        ...base,
        presetPositions: { [id]: moved }
      });
      // Path B: build at original position, then apply the move (partial update).
      const urlPartial = await renderFrame(page, {
        ...base,
        moves: [{ id, position: moved }]
      });

      expect(urlFull).toBeTruthy();
      expect(urlPartial).toBeTruthy();

      const imgA = decodePng(urlFull);
      const imgB = decodePng(urlPartial);
      expect(imgA.width).toBe(imgB.width);
      expect(imgA.height).toBe(imgB.height);

      const { width, height } = imgA;
      const mismatched = pixelmatch(imgA.data, imgB.data, null, width, height, { threshold: 0.1 });

      // Partial and full produce byte-identical model geometry (same builder), so
      // the only possible diff is GPU nondeterminism — effectively 0. We allow a
      // tiny budget (< 0.02% of pixels, ~35 px) for any AA-boundary float jitter
      // between two separate GL contexts. A real partial-update bug (node/edges
      // left at the old position, missing incident edges, wrong block offset)
      // shows the dragged node + its edges in TWO places → thousands of mismatched
      // pixels. Do NOT inflate this budget.
      const budget = Math.ceil(width * height * 0.0002);
      expect(
        mismatched,
        `${label}: partial vs full = ${mismatched} mismatched pixels (budget ${budget})`
      ).toBeLessThanOrEqual(budget);
    });
  }
});

test.describe("WebGL moved-node matches Canvas2D (cross-renderer drag fidelity)", () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto(`file://${HARNESS_HTML}`);
    await page.waitForFunction(() => typeof window.renderFrame === "function");
  });

  test.afterAll(async () => {
    await page?.close();
  });

  // After a drag, the WebGL partial update must still match Canvas2D (which
  // re-projects from _3dLobe every frame). We move the SAME node in BOTH
  // renderers via moveNodeForTest and compare across renderers, within the
  // established node+edge geometry budget. This guards against the WebGL drag
  // diverging from the Canvas2D ground truth.
  const CASES = [
    { label: "hub (projectHub)", id: FIXTURE_NODE_IDS.projectHub, moved: { x: 0.30, y: 0.05, z: 0.50 } },
    { label: "non-hub (nonHub)", id: FIXTURE_NODE_IDS.nonHub, moved: { x: 0.25, y: 0.40, z: 0.10 } }
  ];

  for (const { label, id, moved } of CASES) {
    test(`${label}: webgl drag matches canvas2d`, async () => {
      const base = {
        palette: "graphite",
        rot: { x: -0.15, y: 0.55 },
        zoom: 1,
        dpr: 1,
        now: 1000,
        width: 480,
        height: 360,
        focusId: null,
        hoverId: null,
        highlightLobe: null,
        enabledPasses: ["background", "haze", "cloud", "edges", "nodes"],
        moves: [{ id, position: moved }]
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

      // Same class of difference as the nodes + edges A/B (thin-line/circle AA at
      // the moved position). Budget = union of the edges (0.25%) and nodes (0.15%)
      // per-pass budgets ≈ 0.4% of pixels. A real drag bug (WebGL node/edges at the
      // wrong position vs Canvas2D) is thousands of px / regional — fix it.
      const budget = Math.ceil(width * height * 0.004);
      expect(
        mismatched,
        `${label}: webgl-vs-canvas2d after move = ${mismatched} mismatched pixels (budget ${budget})`
      ).toBeLessThanOrEqual(budget);
    });
  }
});
