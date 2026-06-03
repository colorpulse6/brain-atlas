/**
 * Pure-function tests for src/gl/color.ts.
 * Verifies hexToRgb01 and premultiply agree with how hexA parses hex colors.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { hexToRgb01, premultiply } from "../src/gl/color.ts";

const EPS = 1e-12;

function near(a, b, msg) {
  assert.ok(Math.abs(a - b) <= EPS, `${msg}: expected ${a} ≈ ${b} (diff=${Math.abs(a - b)})`);
}

// hexA from renderer.ts (reference implementation):
//   const h = hex.replace("#", "");
//   return `rgba(${parseInt(h.slice(0,2),16)},…,${alpha})`;
// We compare the r/g/b channel values hexA would use, divided by 255.
function hexAChannels(hex) {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255
  ];
}

test("hexToRgb01 parses #rrggbb to [r/255,g/255,b/255]", () => {
  const [r, g, b] = hexToRgb01("#c9b896");
  near(r, 0xc9 / 255, "r");
  near(g, 0xb8 / 255, "g");
  near(b, 0x96 / 255, "b");
});

test("hexToRgb01 accepts hex string without leading #", () => {
  const withHash = hexToRgb01("#a08060");
  const noHash = hexToRgb01("a08060");
  near(withHash[0], noHash[0], "r matches");
  near(withHash[1], noHash[1], "g matches");
  near(withHash[2], noHash[2], "b matches");
});

test("hexToRgb01 agrees with hexA for #ffffff", () => {
  const ref = hexAChannels("#ffffff");
  const got = hexToRgb01("#ffffff");
  near(got[0], ref[0], "r");
  near(got[1], ref[1], "g");
  near(got[2], ref[2], "b");
  near(got[0], 1, "white r = 1");
  near(got[1], 1, "white g = 1");
  near(got[2], 1, "white b = 1");
});

test("hexToRgb01 agrees with hexA for #000000", () => {
  const ref = hexAChannels("#000000");
  const got = hexToRgb01("#000000");
  near(got[0], ref[0], "r");
  near(got[1], ref[1], "g");
  near(got[2], ref[2], "b");
  near(got[0], 0, "black r = 0");
  near(got[1], 0, "black g = 0");
  near(got[2], 0, "black b = 0");
});

test("hexToRgb01 agrees with hexA for palette hud color #c9b896", () => {
  const ref = hexAChannels("#c9b896");
  const got = hexToRgb01("#c9b896");
  near(got[0], ref[0], "r");
  near(got[1], ref[1], "g");
  near(got[2], ref[2], "b");
});

test("hexToRgb01 agrees with hexA for a saturated magma color #ff6b9d", () => {
  const ref = hexAChannels("#ff6b9d");
  const got = hexToRgb01("#ff6b9d");
  near(got[0], ref[0], "r");
  near(got[1], ref[1], "g");
  near(got[2], ref[2], "b");
});

test("premultiply([0.5,0.4,0.2],0.5) returns [0.25,0.2,0.1,0.5]", () => {
  const [r, g, b, a] = premultiply([0.5, 0.4, 0.2], 0.5);
  near(r, 0.25, "r*alpha");
  near(g, 0.2,  "g*alpha");
  near(b, 0.1,  "b*alpha");
  near(a, 0.5,  "alpha passthrough");
});

test("premultiply with alpha=1 is identity for rgb channels", () => {
  const rgb = [0.3, 0.7, 0.9];
  const [r, g, b, a] = premultiply(rgb, 1);
  near(r, rgb[0], "r");
  near(g, rgb[1], "g");
  near(b, rgb[2], "b");
  near(a, 1,      "alpha");
});

test("premultiply with alpha=0 zeroes all channels", () => {
  const [r, g, b, a] = premultiply([0.8, 0.5, 0.3], 0);
  near(r, 0, "r zeroed");
  near(g, 0, "g zeroed");
  near(b, 0, "b zeroed");
  near(a, 0, "alpha zero");
});

test("hexToRgb01 returns a tuple of length 3 with all values in [0,1]", () => {
  for (const hex of ["#16151a", "#ff8a3d", "#00f5d4", "#536a7a", "#000000", "#ffffff"]) {
    const rgb = hexToRgb01(hex);
    assert.equal(rgb.length, 3, `${hex} length`);
    for (const ch of rgb) {
      assert.ok(ch >= 0 && ch <= 1, `${hex} channel ${ch} in [0,1]`);
    }
  }
});
