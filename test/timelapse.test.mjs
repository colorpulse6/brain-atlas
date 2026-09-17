/**
 * Timelapse: JSONL serialize/parse round-trip, append-only recorder, and the compressed playback schedule.
 * Pure Node, no Obsidian.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ActivityState } from "../src/activity.ts";
import {
  buildPlaybackSchedule,
  parseTimelapse,
  serializeHistory,
  TimelapseRecorder
} from "../src/timelapse.ts";

function stateWithHistory() {
  const state = new ActivityState();
  state.setGraph(["a.md", "b.md"], { "a.md": [], "b.md": [] });
  state.activate("a.md", "read", 1000);
  state.activate("b.md", "write", 2000);
  state.spawnLive("cmd-1", "git status", "command", "temporal", 3000, "git status --porcelain");
  state.endLive("cmd-1", 4000);
  return state;
}

test("serialize/parse is a lossless round-trip of the history rows", () => {
  const state = stateWithHistory();
  const text = serializeHistory(state.fullHistory());
  const rows = parseTimelapse(text);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.event), ["read", "write", "spawn", "end"]);
  assert.equal(rows[2].kind, "command");
  assert.equal(rows[2].label, "git status");
  assert.ok(rows.every((r) => /^#[0-9a-f]{6}$/i.test(r.color)));
});

test("serialize/parse round-trips recorded node positions (xyz)", () => {
  const state = new ActivityState();
  state.setGraph(["a.md"], { "a.md": [] });
  state.spawnLive("cmd-1", "git status", "command", "temporal", 1000);
  state.setLivePos("cmd-1", 0.42, -0.1, 0.9);   // the view placed it here
  const rows = parseTimelapse(serializeHistory(state.fullHistory()));
  const spawn = rows.find((r) => r.event === "spawn");
  assert.deepEqual([spawn.x, spawn.y, spawn.z], [0.42, -0.1, 0.9]);
});

test("parseTimelapse skips malformed lines and sorts by seq", () => {
  const text = [
    "not json",
    JSON.stringify({ seq: 3, event: "end", id: "x", label: "x", kind: "", color: "#fff000", at: 30 }),
    "{}",
    JSON.stringify({ seq: 1, event: "read", id: "a.md", label: "a.md", kind: "", color: "#00ff00", at: 10 })
  ].join("\n");
  const rows = parseTimelapse(text);
  assert.deepEqual(rows.map((r) => r.seq), [1, 3]);
});

test("recorder appends only new rows and never duplicates across flushes", async () => {
  const state = stateWithHistory();
  let file = "";
  const recorder = new TimelapseRecorder(state, { append: (t) => { file += t; } });

  const first = await recorder.flush();
  assert.equal(first, 4);
  assert.equal(parseTimelapse(file).length, 4);

  // nothing new -> nothing written
  assert.equal(await recorder.flush(), 0);

  state.activate("a.md", "read", 5000);
  const second = await recorder.flush();
  assert.equal(second, 1);
  assert.equal(parseTimelapse(file).length, 5); // 4 + 1, no dupes
});

test("recorder primed from an existing file resumes without re-appending", async () => {
  const state = stateWithHistory();
  const existing = parseTimelapse(serializeHistory(state.fullHistory()));
  let file = serializeHistory(state.fullHistory());
  const recorder = new TimelapseRecorder(state, { append: (t) => { file += t; } });
  recorder.primeFrom(existing);
  assert.equal(await recorder.flush(), 0); // already have all four
});

test("playback schedule preserves order, starts at 0 and ends at totalMs", () => {
  const rows = parseTimelapse(serializeHistory(stateWithHistory().fullHistory()));
  const schedule = buildPlaybackSchedule(rows, { totalMs: 30000 });
  assert.equal(schedule.length, 4);
  assert.equal(schedule[0].at, 0);
  assert.equal(schedule[schedule.length - 1].at, 30000);
  for (let i = 1; i < schedule.length; i += 1) assert.ok(schedule[i].at >= schedule[i - 1].at);
});

test("playback caps long idle gaps so they don't dominate the window", () => {
  const rows = [
    { seq: 1, at: 0, event: "read", kind: "", id: "a.md", label: "a", color: "#0f0" },
    { seq: 2, at: 1000, event: "read", kind: "", id: "b.md", label: "b", color: "#0f0" },
    { seq: 3, at: 100000000, event: "read", kind: "", id: "a.md", label: "a", color: "#0f0" } // huge gap
  ];
  const capped = buildPlaybackSchedule(rows, { totalMs: 30000, maxGapMs: 1000 });
  // With both gaps capped to 1000, the two gaps are equal, so the middle step lands at the halfway mark.
  assert.equal(capped[1].at, 15000);
  assert.equal(capped[2].at, 30000);
});

test("empty history yields an empty schedule", () => {
  assert.deepEqual(buildPlaybackSchedule([]), []);
  assert.equal(serializeHistory([]), "");
});
