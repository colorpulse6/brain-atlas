import assert from "node:assert/strict";
import test from "node:test";

import {
  allLobesEnabled,
  lobeVisibilityMultiplier,
  setAllLobes,
  setLobeEnabled
} from "../src/lobe-visibility.ts";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings.ts";

test("default settings enable every anatomical region", () => {
  assert.deepEqual(DEFAULT_SETTINGS.enabledLobes, {
    frontal: true,
    parietal: true,
    temporal: true,
    occipital: true,
    cerebellum: true,
    stem: true
  });
});

test("normalizeSettings preserves persisted lobe visibility and fills missing lobes", () => {
  const settings = normalizeSettings({ enabledLobes: { temporal: false } });

  assert.equal(settings.enabledLobes.temporal, false);
  assert.equal(settings.enabledLobes.frontal, true);
});

test("lobeVisibilityMultiplier dims disabled lobes below hover-isolated lobes", () => {
  const visibility = { ...allLobesEnabled(), temporal: false };

  assert.equal(lobeVisibilityMultiplier("temporal", visibility, null), 0.08);
  assert.equal(lobeVisibilityMultiplier("frontal", visibility, "frontal"), 1);
  assert.equal(lobeVisibilityMultiplier("parietal", visibility, "frontal"), 0.16);
  assert.equal(lobeVisibilityMultiplier("temporal", visibility, "temporal"), 0.08);
});

test("lobe visibility helpers toggle one lobe or all lobes immutably", () => {
  const hidden = setLobeEnabled(allLobesEnabled(), "occipital", false);
  const restored = setLobeEnabled(hidden, "occipital", true);

  assert.equal(hidden.occipital, false);
  assert.equal(allLobesEnabled().occipital, true);
  assert.equal(restored.occipital, true);
  assert.deepEqual(setAllLobes(false), {
    frontal: false,
    parietal: false,
    temporal: false,
    occipital: false,
    cerebellum: false,
    stem: false
  });
});
