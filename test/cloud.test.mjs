/**
 * Pure-function tests for src/cloud.ts buildBrainCloud().
 *
 * buildBrainCloud is the shared point-cloud builder used by BOTH the Canvas2D
 * renderer and the WebGL2 renderer, so its output must stay byte-stable: the
 * A/B pixel-diff gate relies on both renderers projecting identical points.
 *
 * These tests lock the counts, lobe assignment, and twinkle phase/freq formulas
 * that previously lived in BrainRenderer.buildCloud(). No WebGL, no DOM.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildBrainCloud } from "../src/cloud.ts";

test("buildBrainCloud produces 1648 points (1400 surface + 220 cerebellum + 28 stem)", () => {
  const cloud = buildBrainCloud();
  assert.equal(cloud.length, 1648);

  const cerebellum = cloud.filter((p) => p.lobe === "cerebellum");
  const stem = cloud.filter((p) => p.lobe === "stem");
  // Cerebellum: all 220 dedicated points are lobe "cerebellum". (Surface points
  // can also classify as cerebellum via lobeFor, so assert >= 220 here.)
  assert.ok(cerebellum.length >= 220, `cerebellum count ${cerebellum.length}`);
  // Stem: exactly 28 dedicated stem points; surface lobeFor can also yield stem.
  assert.ok(stem.length >= 28, `stem count ${stem.length}`);
});

test("buildBrainCloud surface points carry lobeFor + index-derived twinkle attrs", () => {
  const cloud = buildBrainCloud();
  // First 1400 are the surface points (deterministic generation order).
  const surface = cloud.slice(0, 1400);
  for (let i = 0; i < surface.length; i += 1) {
    const p = surface[i];
    assert.equal(p.twPhase, (i * 0.731) % (Math.PI * 2));
    assert.equal(p.twFreq, 0.4 + (i % 9) / 12);
    assert.ok(typeof p.lobe === "string");
  }
});

test("buildBrainCloud cerebellum + stem points carry their dedicated twinkle attrs", () => {
  const cloud = buildBrainCloud();
  const cerebellum = cloud.slice(1400, 1620);
  for (let i = 0; i < cerebellum.length; i += 1) {
    const p = cerebellum[i];
    assert.equal(p.lobe, "cerebellum");
    assert.equal(p.twPhase, (i * 0.91) % (Math.PI * 2));
    assert.equal(p.twFreq, 0.5 + (i % 5) / 8);
  }
  const stem = cloud.slice(1620, 1648);
  for (let i = 0; i < stem.length; i += 1) {
    const p = stem[i];
    assert.equal(p.lobe, "stem");
    assert.equal(p.twPhase, i * 0.55);
    assert.equal(p.twFreq, 0.3);
  }
});

test("buildBrainCloud is deterministic across calls", () => {
  const a = buildBrainCloud();
  const b = buildBrainCloud();
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i += 1) {
    assert.equal(a[i].x, b[i].x);
    assert.equal(a[i].y, b[i].y);
    assert.equal(a[i].z, b[i].z);
    assert.equal(a[i].lobe, b[i].lobe);
    assert.equal(a[i].twPhase, b[i].twPhase);
    assert.equal(a[i].twFreq, b[i].twFreq);
  }
});
