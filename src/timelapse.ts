/**
 * Timelapse: persist the activity history to a JSONL file so the whole life of a project can be
 * "played back" later -- watch the brain glow and grow. Two pure pieces (no Obsidian imports, so they
 * run under `node --test`) plus a thin recorder that takes an injected append/read sink:
 *
 *   - serializeHistory / parseTimelapse  HistoryEntry[] <-> JSONL text (one compact JSON object per line)
 *   - buildPlaybackSchedule              map recorded timestamps onto a compressed [0, totalMs] window,
 *                                        preserving the order and the *shape* of the gaps (long idle gaps
 *                                        are capped so a month of work still replays in ~half a minute)
 *   - TimelapseRecorder                  flush() appends only the history entries newer than the last flush
 *
 * The plugin writes the JSONL under its own data dir and, on the "Play timelapse" command, reads it back,
 * builds a schedule, and re-feeds the events into the live ActivityState so the existing renderer re-glows.
 */
import type { HistoryEntry } from "./activity.ts";

/** One recorded action as it lives on disk (a superset-safe subset of HistoryEntry). */
export interface TimelapseRow {
  seq: number;
  at: number;
  event: string;
  kind: string;
  id: string;
  label: string;
  color: string;
  /** The node's 3D position when it happened (present for live spawns/ends the view placed). */
  x?: number;
  y?: number;
  z?: number;
}

/** Serialize history entries to JSONL text (one compact object per line, trailing newline). */
export function serializeHistory(entries: HistoryEntry[]): string {
  if (entries.length === 0) return "";
  return entries.map((e) => JSON.stringify(toRow(e))).join("\n") + "\n";
}

function toRow(e: HistoryEntry): TimelapseRow {
  const row: TimelapseRow = { seq: e.seq, at: e.at, event: e.event, kind: e.kind, id: e.id, label: e.label, color: e.color };
  if (e.x !== undefined) { row.x = e.x; row.y = e.y; row.z = e.z; }
  return row;
}

/** Parse JSONL timelapse text back into rows, oldest first; malformed lines are skipped. */
export function parseTimelapse(text: string): TimelapseRow[] {
  const out: TimelapseRow[] = [];
  for (const raw of (text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }
    if (!data || typeof data !== "object") continue;
    const p = data as Record<string, unknown>;
    if (typeof p.seq !== "number" || typeof p.event !== "string" || typeof p.id !== "string") continue;
    const row: TimelapseRow = {
      seq: p.seq,
      at: typeof p.at === "number" ? p.at : 0,
      event: p.event,
      kind: typeof p.kind === "string" ? p.kind : "",
      id: p.id,
      label: typeof p.label === "string" ? p.label : p.id,
      color: typeof p.color === "string" ? p.color : "#ffb02e"
    };
    if (typeof p.x === "number" && typeof p.y === "number" && typeof p.z === "number") {
      row.x = p.x; row.y = p.y; row.z = p.z;
    }
    out.push(row);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

export interface PlaybackStep {
  /** Milliseconds from playback start at which to replay this row. */
  at: number;
  row: TimelapseRow;
}

export interface PlaybackOptions {
  /** Target wall-clock length of the whole playback (ms). Default 30s. */
  totalMs?: number;
  /** Cap on a single inter-event gap before compression, so idle nights don't dominate (ms). Default 5min. */
  maxGapMs?: number;
}

/**
 * Turn recorded rows into a schedule of {at, row} steps over a compressed window. Preserves order and the
 * relative shape of gaps (each real gap is capped at maxGapMs first, then the whole thing is scaled so the
 * last step lands at totalMs). Recorded timestamps use performance.now(), which resets per session, so a
 * negative or backwards gap is treated as zero.
 */
export function buildPlaybackSchedule(rows: TimelapseRow[], options: PlaybackOptions = {}): PlaybackStep[] {
  const totalMs = Math.max(1000, options.totalMs ?? 30000);
  const maxGapMs = Math.max(1, options.maxGapMs ?? 5 * 60 * 1000);
  if (rows.length === 0) return [];
  if (rows.length === 1) return [{ at: 0, row: rows[0] }];

  // Cumulative capped time along the recording.
  const cum: number[] = [0];
  for (let i = 1; i < rows.length; i += 1) {
    const gap = Math.min(maxGapMs, Math.max(0, rows[i].at - rows[i - 1].at));
    cum.push(cum[i - 1] + gap);
  }
  const span = cum[cum.length - 1] || 1;
  const scale = totalMs / span;
  return rows.map((row, i) => ({ at: Math.round(cum[i] * scale), row }));
}

/** Sink the recorder writes through (injected: the plugin uses the vault adapter, tests use memory). */
export interface TimelapseSink {
  append(text: string): void | Promise<void>;
}

/** Reads new history entries from a source and appends them to a sink as JSONL. */
export interface HistorySource {
  historySince(afterSeq: number): HistoryEntry[];
}

/**
 * Appends new history to a JSONL sink. Call flush() on an interval and on unload; it only ever writes the
 * entries added since the previous flush (tracked by seq), so the file grows append-only with no dupes.
 */
export class TimelapseRecorder {
  private lastSeq = 0;
  private readonly source: HistorySource;
  private readonly sink: TimelapseSink;

  constructor(source: HistorySource, sink: TimelapseSink) {
    this.source = source;
    this.sink = sink;
  }

  /** Start counting from an existing file's highest seq so a reload doesn't re-append old rows. */
  primeFrom(rows: TimelapseRow[]): void {
    for (const r of rows) if (r.seq > this.lastSeq) this.lastSeq = r.seq;
  }

  /** Append everything newer than the last flush. Returns the number of rows written. */
  async flush(): Promise<number> {
    const fresh = this.source.historySince(this.lastSeq);
    if (fresh.length === 0) return 0;
    await this.sink.append(serializeHistory(fresh));
    this.lastSeq = fresh[fresh.length - 1].seq;
    return fresh.length;
  }
}
