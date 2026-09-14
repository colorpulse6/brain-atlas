/**
 * Live activity: light up nodes as an external tool (Claude Code hooks) reads and writes notes.
 *
 * Two pure pieces, no Obsidian imports, so they run under `node --test`:
 *   - ActivityState    per-node activation levels (swell + hold + exponential decay + cascade to neighbours)
 *   - ActivityListener a loopback HTTP server that accepts Claude Code hook payloads on POST /read
 *
 * Contract (mirrors the Neural Vault plugin so one hook can feed both):
 *   POST http://127.0.0.1:<port>/read   body = Claude Code hook JSON:
 *        { "tool_name": "Read" | "Edit" | "Write" | "MultiEdit" | "NotebookEdit" | "Skill",
 *          "tool_input": { "file_path": "knowledge/architecture/framework-overview.md" } }
 *        file_path is vault-relative POSIX; an absolute path is tolerated (vault base stripped,
 *        backslashes converted). notebook_path and a top-level file_path are accepted too.
 *        Always answers 200 "ok". Unknown paths are counted in `missed` and ignored.
 *   GET  /status  -> { port, enabled, active, lastPath, lastKind, nodeCount, missed, events }
 *
 * Semantics: an event sets the node's activation to 1 (kind read = Read/Skill, write = the edit tools);
 * linked neighbours get max(existing, cascade). A level holds for holdSeconds, then decays as
 * exp(-(elapsed - hold) / decaySeconds); entries below 0.01 are dropped. Renderers lerp the node color
 * toward readColor / writeColor by the level and scale its radius by (1 + swell * level).
 */

export type ActivityKind = "read" | "write";

export interface ActivityEntry {
  /** Peak level set at activation (1 for the hit node, cascade for a neighbour). */
  peak: number;
  /** Current level in [0, 1], recomputed by tick(). */
  level: number;
  kind: ActivityKind;
  /** Timestamp (same clock as tick's `now`) of the activation. */
  at: number;
}

export interface ActivityOptions {
  holdSeconds: number;
  decaySeconds: number;
  cascade: number;
  swell: number;
  readColor: string;
  writeColor: string;
}

export const DEFAULT_ACTIVITY_OPTIONS: ActivityOptions = {
  holdSeconds: 2.5,
  decaySeconds: 0.5,
  cascade: 0.45,
  swell: 2,
  readColor: "#00ff00",
  writeColor: "#ff0000"
};

export interface ActivityStatus {
  active: number;
  lastPath: string | null;
  lastKind: ActivityKind | null;
  nodeCount: number;
  missed: number;
  events: number;
}

const MIN_LEVEL = 0.01;

const READ_TOOLS = new Set(["read", "skill"]);
const WRITE_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);

/** Map a Claude Code tool name to an activity kind (null = not a note event). */
export function kindForTool(toolName: unknown): ActivityKind | null {
  if (typeof toolName !== "string") return null;
  const name = toolName.trim().toLowerCase();
  if (READ_TOOLS.has(name)) return "read";
  if (WRITE_TOOLS.has(name)) return "write";
  return null;
}

/**
 * Turn whatever path the hook sent into the vault-relative POSIX id the graph uses
 * (`folder/note.md`). Backslashes become slashes; the vault base path (any slash form,
 * case-insensitive) is stripped; a leading "./" or "/" is dropped.
 */
export function normalizePath(raw: unknown, vaultBase?: string | null): string | null {
  if (typeof raw !== "string") return null;
  let path = raw.trim().replace(/\\/g, "/");
  if (!path) return null;
  if (vaultBase) {
    const base = vaultBase.replace(/\\/g, "/").replace(/\/+$/, "");
    if (base && path.toLowerCase().startsWith(base.toLowerCase() + "/")) {
      path = path.slice(base.length + 1);
    }
  }
  path = path.replace(/^\.\//, "").replace(/^\/+/, "");
  return path || null;
}

export interface ParsedEvent {
  path: string;
  kind: ActivityKind;
}

/** Parse a hook payload body into {path, kind}; null when it is not a note event. */
export function parseEventBody(body: string, vaultBase?: string | null): ParsedEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const payload = data as Record<string, unknown>;
  const input = (payload.tool_input && typeof payload.tool_input === "object")
    ? (payload.tool_input as Record<string, unknown>)
    : {};
  const rawPath = input.file_path ?? input.notebook_path ?? payload.file_path;
  const path = normalizePath(rawPath, vaultBase);
  const kind = kindForTool(payload.tool_name) ?? "read";
  if (!path) return null;
  return { path, kind };
}

/** Parse "#rrggbb" into [r, g, b] in [0, 1]; a bad string yields white. */
export function hexToRgb01(hex: string): [number, number, number] {
  const h = (hex || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return [1, 1, 1];
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

/** Lerp a base color toward a target hex by t, returning [r, g, b] in [0, 1]. */
export function lerpRgb01(base: [number, number, number], targetHex: string, t: number): [number, number, number] {
  const target = hexToRgb01(targetHex);
  const k = Math.max(0, Math.min(1, t));
  return [
    base[0] + (target[0] - base[0]) * k,
    base[1] + (target[1] - base[1]) * k,
    base[2] + (target[2] - base[2]) * k
  ];
}

/** Lerp two "#rrggbb" colors by t into a CSS "#rrggbb" string. */
export function lerpHexColor(a: string, b: string, t: number): string {
  const [r, g, bl] = lerpRgb01(hexToRgb01(a), b, t);
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(bl)}`;
}

/**
 * Per-node activation levels shared by every open atlas view. The view feeds it the
 * current graph (ids + adjacency) on every rebuild; the listener feeds it events; the
 * renderers call tick(now) once per frame and read levels while drawing.
 */
export class ActivityState {
  options: ActivityOptions;
  private entries = new Map<string, ActivityEntry>();
  private ids = new Set<string>();
  private adj: Record<string, string[]> = {};
  private lastPath: string | null = null;
  private lastKind: ActivityKind | null = null;
  private missed = 0;
  private events = 0;

  constructor(options: Partial<ActivityOptions> = {}) {
    this.options = { ...DEFAULT_ACTIVITY_OPTIONS, ...options };
  }

  setOptions(options: Partial<ActivityOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /** Replace the node universe (ids) and adjacency; stale activations are dropped. */
  setGraph(ids: Iterable<string>, adj: Record<string, string[]>): void {
    this.ids = new Set(ids);
    this.adj = adj;
    for (const id of [...this.entries.keys()]) {
      if (!this.ids.has(id)) this.entries.delete(id);
    }
  }

  get nodeCount(): number {
    return this.ids.size;
  }

  /**
   * Light `path` (and, at `cascade`, its neighbours). Returns true when the path is a node.
   * `now` must be on the same clock the renderer passes to tick().
   */
  activate(path: string, kind: ActivityKind, now: number): boolean {
    this.events += 1;
    this.lastPath = path;
    this.lastKind = kind;
    const id = this.resolve(path);
    if (!id) {
      this.missed += 1;
      return false;
    }
    this.entries.set(id, { peak: 1, level: 1, kind, at: now });
    const cascade = Math.max(0, Math.min(1, this.options.cascade));
    if (cascade > 0) {
      for (const neighbour of this.adj[id] ?? []) {
        if (!this.ids.has(neighbour)) continue;
        const existing = this.entries.get(neighbour);
        if (existing && existing.level >= cascade) continue;
        this.entries.set(neighbour, { peak: cascade, level: cascade, kind, at: now });
      }
    }
    return true;
  }

  /** Recompute every level for `now`; drop the faded ones. Returns true while anything glows. */
  tick(now: number): boolean {
    const hold = Math.max(0, this.options.holdSeconds) * 1000;
    const decay = Math.max(0.05, this.options.decaySeconds) * 1000;
    for (const [id, entry] of this.entries) {
      const elapsed = Math.max(0, now - entry.at);
      const level = elapsed <= hold ? entry.peak : entry.peak * Math.exp(-(elapsed - hold) / decay);
      if (level < MIN_LEVEL) {
        this.entries.delete(id);
      } else {
        entry.level = level;
      }
    }
    return this.entries.size > 0;
  }

  /** The node's entry while it glows (level >= 0.01), else undefined. */
  get(id: string): ActivityEntry | undefined {
    const entry = this.entries.get(id);
    return entry && entry.level >= MIN_LEVEL ? entry : undefined;
  }

  /** Live (id, entry) pairs. */
  *active(): IterableIterator<[string, ActivityEntry]> {
    for (const pair of this.entries) {
      if (pair[1].level >= MIN_LEVEL) yield pair;
    }
  }

  activeCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (entry.level >= MIN_LEVEL) n += 1;
    }
    return n;
  }

  clear(): void {
    this.entries.clear();
  }

  status(): ActivityStatus {
    return {
      active: this.activeCount(),
      lastPath: this.lastPath,
      lastKind: this.lastKind,
      nodeCount: this.ids.size,
      missed: this.missed,
      events: this.events
    };
  }

  /** Resolve a posted path to a node id: exact, then with ".md", then case-insensitive. */
  private resolve(path: string): string | null {
    if (this.ids.has(path)) return path;
    const withMd = path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
    if (this.ids.has(withMd)) return withMd;
    const lower = withMd.toLowerCase();
    for (const id of this.ids) {
      if (id.toLowerCase() === lower) return id;
    }
    return null;
  }
}

/** Minimal shape of Node's http module that the listener needs (injected, so tests and Electron both work). */
export interface HttpLike {
  createServer(handler: (req: HttpRequestLike, res: HttpResponseLike) => void): HttpServerLike;
}

export interface HttpRequestLike {
  method?: string;
  url?: string;
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

export interface HttpResponseLike {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body?: string): unknown;
}

export interface HttpServerLike {
  listen(port: number, host: string, callback?: () => void): unknown;
  close(callback?: () => void): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
  address(): { port: number } | string | null;
}

export interface ActivityListenerOptions {
  http: HttpLike;
  onEvent: (event: ParsedEvent) => void;
  status: () => ActivityStatus;
  vaultBase?: string | null;
  /** Bodies longer than this are truncated before parsing (default 1 MiB). */
  maxBodyBytes?: number;
}

/** Loopback HTTP listener for the hook payloads. One instance per plugin. */
export class ActivityListener {
  private server: HttpServerLike | null = null;
  private port = 0;
  private readonly opts: ActivityListenerOptions;

  constructor(opts: ActivityListenerOptions) {
    this.opts = opts;
  }

  /** Bound port while running, else 0. */
  get boundPort(): number {
    return this.port;
  }

  get running(): boolean {
    return this.server !== null;
  }

  /** Start on `port` (0 = any free port). Resolves with the bound port; rejects on bind failure. */
  start(port: number): Promise<number> {
    this.stop();
    const server = this.opts.http.createServer((req, res) => this.handle(req, res));
    this.server = server;
    return new Promise<number>((resolve, reject) => {
      server.once("error", (error) => {
        this.server = null;
        this.port = 0;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        this.port = address && typeof address === "object" ? address.port : port;
        resolve(this.port);
      });
    });
  }

  stop(): void {
    const server = this.server;
    this.server = null;
    this.port = 0;
    if (server) {
      try {
        server.close();
      } catch {
        // already closed
      }
    }
  }

  private handle(req: HttpRequestLike, res: HttpResponseLike): void {
    const method = (req.method || "GET").toUpperCase();
    const url = (req.url || "/").split("?")[0];
    if (method === "POST" && url === "/read") {
      const limit = this.opts.maxBodyBytes ?? 1024 * 1024;
      let body = "";
      let truncated = false;
      req.on("data", (chunk) => {
        if (body.length < limit) body += String(chunk);
        else truncated = true;
      });
      req.on("error", () => this.reply(res, 200, "ok"));
      req.on("end", () => {
        const event = parseEventBody(truncated ? body.slice(0, 65536) : body, this.opts.vaultBase);
        if (event) {
          try {
            this.opts.onEvent(event);
          } catch (error) {
            console.warn("Brain Atlas activity: event handler failed", error);
          }
        }
        this.reply(res, 200, "ok");
      });
      return;
    }
    if (method === "GET" && url === "/status") {
      const status = { port: this.port, enabled: true, ...this.opts.status() };
      this.reply(res, 200, JSON.stringify(status), "application/json");
      return;
    }
    this.reply(res, 404, "not found");
  }

  private reply(res: HttpResponseLike, status: number, body: string, type = "text/plain"): void {
    try {
      res.writeHead(status, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
      res.end(body);
    } catch {
      // the client went away
    }
  }
}
