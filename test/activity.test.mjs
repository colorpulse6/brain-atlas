/**
 * Live activity: activation state (hold, decay, cascade) and the loopback listener
 * (POST /read with a Claude Code hook payload, GET /status). Pure Node, no Obsidian.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  ActivityListener,
  ActivityState,
  kindForTool,
  lerpHexColor,
  lerpRgb01,
  normalizePath,
  parseEventBody,
  parseLiveBody
} from "../src/activity.ts";

const IDS = ["a.md", "folder/b.md", "folder/c.md", "lonely.md"];
const ADJ = { "a.md": ["folder/b.md"], "folder/b.md": ["a.md", "folder/c.md"], "folder/c.md": ["folder/b.md"], "lonely.md": [] };

function stateWithGraph(options = {}) {
  const state = new ActivityState({ holdSeconds: 1, decaySeconds: 0.5, cascade: 0.45, swell: 2, ...options });
  state.setGraph(IDS, ADJ);
  return state;
}

test("kindForTool maps Claude Code tools to read/write", () => {
  assert.equal(kindForTool("Read"), "read");
  assert.equal(kindForTool("Skill"), "read");
  assert.equal(kindForTool("Edit"), "write");
  assert.equal(kindForTool("MultiEdit"), "write");
  assert.equal(kindForTool("NotebookEdit"), "write");
  assert.equal(kindForTool("Bash"), null);
  assert.equal(kindForTool(undefined), null);
});

test("normalizePath yields the vault-relative posix id", () => {
  assert.equal(normalizePath("folder/b.md"), "folder/b.md");
  assert.equal(normalizePath("folder\\b.md"), "folder/b.md");
  assert.equal(normalizePath("E:\\Vault\\folder\\b.md", "E:\\Vault"), "folder/b.md");
  assert.equal(normalizePath("e:/vault/folder/b.md", "E:\\Vault\\"), "folder/b.md");
  assert.equal(normalizePath("./a.md"), "a.md");
  assert.equal(normalizePath(""), null);
  assert.equal(normalizePath(42), null);
});

test("parseEventBody reads tool_input.file_path, notebook_path and a top-level file_path", () => {
  assert.deepEqual(parseEventBody(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "a.md" } })), { path: "a.md", kind: "read" });
  assert.deepEqual(parseEventBody(JSON.stringify({ tool_name: "Write", tool_input: { notebook_path: "n.ipynb" } })), { path: "n.ipynb", kind: "write" });
  assert.deepEqual(parseEventBody(JSON.stringify({ tool_name: "Edit", file_path: "a.md" })), { path: "a.md", kind: "write" });
  assert.deepEqual(parseEventBody(JSON.stringify({ tool_input: { file_path: "a.md" } })), { path: "a.md", kind: "read" });
  assert.equal(parseEventBody("not json"), null);
  assert.equal(parseEventBody(JSON.stringify({ tool_name: "Read" })), null);
});

test("activate lights the node at 1 and its neighbours at cascade; unknown paths are missed", () => {
  const state = stateWithGraph();
  assert.equal(state.activate("folder/b.md", "read", 0), true);
  assert.equal(state.get("folder/b.md").level, 1);
  assert.equal(state.get("folder/b.md").kind, "read");
  assert.equal(state.get("a.md").level, 0.45);
  assert.equal(state.get("folder/c.md").level, 0.45);
  assert.equal(state.get("lonely.md"), undefined);
  assert.equal(state.activeCount(), 3);
  assert.equal(state.activate("nope.md", "read", 0), false);
  assert.equal(state.status().missed, 1);
  assert.equal(state.status().events, 2);
  assert.equal(state.status().nodeCount, 4);
});

test("activate resolves an id without .md and case-insensitively; a stronger neighbour is not lowered", () => {
  const state = stateWithGraph();
  assert.equal(state.activate("folder/c", "write", 0), true);
  assert.equal(state.get("folder/c.md").kind, "write");
  assert.equal(state.activate("FOLDER/B.md", "read", 0), true);
  // c was lit at 1 by its own event; b's cascade (0.45) must not lower it
  assert.equal(state.get("folder/c.md").level, 1);
  assert.equal(state.get("folder/c.md").kind, "write");
});

test("tick holds for holdSeconds, then decays exponentially and drops below 0.01", () => {
  const state = stateWithGraph({ holdSeconds: 1, decaySeconds: 0.5 });
  state.activate("a.md", "read", 1000);
  assert.equal(state.tick(1500), true);
  assert.equal(state.get("a.md").level, 1, "inside the hold the level stays at the peak");
  assert.equal(state.tick(2000), true);
  assert.equal(state.get("a.md").level, 1, "the hold boundary is inclusive");
  state.tick(2500); // 0.5 s past the hold = one time constant
  const level = state.get("a.md").level;
  assert.ok(Math.abs(level - Math.exp(-1)) < 1e-9, `expected e^-1, got ${level}`);
  const neighbour = state.get("folder/b.md").level;
  assert.ok(Math.abs(neighbour - 0.45 * Math.exp(-1)) < 1e-9, "the cascade decays from its own peak");
  assert.equal(state.tick(2000 + 0.5 * 1000 * 5), false, "five time constants later everything has faded");
  assert.equal(state.get("a.md"), undefined);
  assert.equal(state.activeCount(), 0);
});

test("setGraph drops activations for nodes that no longer exist", () => {
  const state = stateWithGraph();
  state.activate("a.md", "read", 0);
  state.setGraph(["folder/b.md"], { "folder/b.md": [] });
  assert.equal(state.get("a.md"), undefined);
  assert.equal(state.get("folder/b.md").level, 0.45, "the surviving neighbour keeps its cascade level");
});

test("color helpers lerp toward the target", () => {
  assert.deepEqual(lerpRgb01([0, 0, 0], "#ffffff", 0.5), [0.5, 0.5, 0.5]);
  assert.equal(lerpHexColor("#000000", "#00ff00", 1), "#00ff00");
  assert.equal(lerpHexColor("#000000", "#00ff00", 0), "#000000");
  assert.equal(lerpHexColor("#102030", "#ffffff", 0.5), "#889098");
});

test("listener accepts POST /read and answers GET /status", async () => {
  const state = stateWithGraph();
  const events = [];
  const listener = new ActivityListener({
    http,
    vaultBase: "E:\\Vault",
    onEvent: (event) => {
      events.push(event);
      state.activate(event.path, event.kind, 0);
    },
    status: () => state.status()
  });
  const port = await listener.start(0);
  assert.ok(port > 0, "bound a free port");
  assert.equal(listener.boundPort, port);
  try {
    const body = JSON.stringify({ tool_name: "Read", tool_input: { file_path: "E:\\Vault\\folder\\b.md" } });
    const posted = await request(port, "POST", "/read", body);
    assert.equal(posted.status, 200);
    assert.equal(posted.body, "ok");
    assert.deepEqual(events, [{ path: "folder/b.md", kind: "read" }]);
    assert.equal(state.get("folder/b.md").level, 1);

    const junk = await request(port, "POST", "/read", "{ not json");
    assert.equal(junk.status, 200, "a bad body is still answered ok");
    assert.equal(events.length, 1);

    const status = await request(port, "GET", "/status");
    assert.equal(status.status, 200);
    const parsed = JSON.parse(status.body);
    assert.equal(parsed.port, port);
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.active, 3);
    assert.equal(parsed.lastPath, "folder/b.md");
    assert.equal(parsed.lastKind, "read");
    assert.equal(parsed.nodeCount, 4);
    assert.equal(parsed.events, 1);

    const missing = await request(port, "GET", "/nope");
    assert.equal(missing.status, 404);
  } finally {
    listener.stop();
  }
  assert.equal(listener.running, false);
});

test("listener reports a bind failure instead of throwing", async () => {
  const blocker = http.createServer(() => {});
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = blocker.address().port;
  const listener = new ActivityListener({ http, onEvent: () => {}, status: () => new ActivityState().status() });
  await assert.rejects(listener.start(port));
  assert.equal(listener.running, false);
  await new Promise((resolve) => blocker.close(resolve));
});

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { "Content-Type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- Live (transient) nodes: commands / terminals / subagents Claude runs -----------------

test("parseLiveBody parses spawn and end, clamps kind, defaults region", () => {
  const spawn = parseLiveBody(JSON.stringify({ op: "spawn", id: "t1", label: "git status", kind: "command" }));
  assert.deepEqual(spawn, { op: "spawn", id: "t1", label: "git status", kind: "command", region: "temporal" });
  const agent = parseLiveBody(JSON.stringify({ op: "spawn", id: "a1", label: "code-reviewer", kind: "agent", region: "temporal" }));
  assert.equal(agent.kind, "agent");
  const end = parseLiveBody(JSON.stringify({ op: "end", id: "t1" }));
  assert.deepEqual(end, { op: "end", id: "t1", label: "", kind: "command", region: "temporal" });
  assert.equal(parseLiveBody(JSON.stringify({ op: "spawn", id: "x", kind: "bogus" })).kind, "command");
  assert.equal(parseLiveBody(JSON.stringify({ op: "spawn" })), null); // no id
  assert.equal(parseLiveBody(JSON.stringify({ id: "x" })), null);     // no op
  assert.equal(parseLiveBody("not json"), null);
});

test("spawnLive holds at full while active, then decays and is removed after end", () => {
  const state = new ActivityState({ liveDecaySeconds: 0.5, liveMaxSeconds: 180 });
  state.spawnLive("t1", "pytest -q", "command", "temporal", 0);
  state.tick(0);
  let live = state.liveNodes();
  assert.equal(live.length, 1);
  assert.equal(live[0].label, "pytest -q");
  assert.equal(live[0].active, true);
  assert.equal(live[0].level, 1);
  // still full while active, even seconds later
  state.tick(10_000);
  assert.equal(state.liveNodes()[0].level, 1);
  // end -> decays
  state.endLive("t1", 10_000);
  state.tick(10_250); // 0.25s into a 0.5s decay
  const fading = state.liveNodes();
  assert.equal(fading.length, 1);
  assert.ok(fading[0].level < 1 && fading[0].level > 0.1, `level ${fading[0].level}`);
  // fully gone after a few decay constants
  state.tick(14_000);
  assert.equal(state.liveNodes().length, 0);
  assert.equal(state.liveCount(), 0);
});

test("an active live node with no end event is TTL-expired", () => {
  const state = new ActivityState({ liveDecaySeconds: 0.5, liveMaxSeconds: 2 });
  state.spawnLive("stuck", "hung command", "command", "temporal", 0);
  state.tick(1_000);
  assert.equal(state.liveNodes()[0].active, true);
  state.tick(2_500); // past the 2s TTL -> force-ended, now fading
  const after = state.liveNodes();
  if (after.length) assert.equal(after[0].active, false);
  state.tick(6_000); // decayed away
  assert.equal(state.liveNodes().length, 0);
});

test("spawnLive refresh keeps the original bornAt and reactivates", () => {
  const state = new ActivityState({ liveDecaySeconds: 0.5, liveMaxSeconds: 180 });
  state.spawnLive("t1", "first", "command", "temporal", 100);
  state.endLive("t1", 200);
  state.spawnLive("t1", "second", "command", "temporal", 300);
  state.tick(300);
  const live = state.liveNodes();
  assert.equal(live.length, 1);
  assert.equal(live[0].active, true);
  assert.equal(live[0].label, "second");
  assert.equal(live[0].bornAt, 100); // original spawn time preserved
});

test("liveColor maps kinds and status reports live count + lastLive", () => {
  const state = new ActivityState({ liveCommandColor: "#111111", liveAgentColor: "#222222", liveTerminalColor: "#333333" });
  assert.equal(state.liveColor("command"), "#111111");
  assert.equal(state.liveColor("agent"), "#222222");
  assert.equal(state.liveColor("terminal"), "#333333");
  state.spawnLive("a1", "code-reviewer", "agent", "temporal", 0);
  state.tick(0);
  const s = state.status();
  assert.equal(s.live, 1);
  assert.equal(s.lastLive, "code-reviewer");
});

test("tick returns true while a live node glows even with no note activity", () => {
  const state = new ActivityState();
  assert.equal(state.tick(0), false);
  state.spawnLive("t1", "x", "command", "temporal", 0);
  assert.equal(state.tick(0), true);
});

test("listener POST /live invokes onLive with the parsed event", async () => {
  const events = [];
  const listener = new ActivityListener({
    http,
    onEvent: () => {},
    onLive: (ev) => events.push(ev),
    status: () => ({ active: 0, lastPath: null, lastKind: null, nodeCount: 0, missed: 0, events: 0, live: 0, lastLive: null })
  });
  const port = await listener.start(0);
  try {
    await postJson(port, "/live", { op: "spawn", id: "t1", label: "git push", kind: "terminal" });
    await postJson(port, "/live", { op: "end", id: "t1" });
  } finally {
    listener.stop();
  }
  assert.equal(events.length, 2);
  assert.equal(events[0].op, "spawn");
  assert.equal(events[0].kind, "terminal");
  assert.equal(events[1].op, "end");
});

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        res.on("data", () => {});
        res.on("end", resolve);
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}
