import { describe, expect, test } from "bun:test";
import { demuxLogs } from "./logs.ts";
import { createNdjsonParser, createPullTracker } from "./pull-progress.ts";
import { computeStats } from "./stats.ts";

function frame(stream: 1 | 2, text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const out = new Uint8Array(8 + payload.length);
  out[0] = stream;
  new DataView(out.buffer).setUint32(4, payload.length);
  out.set(payload, 8);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

describe("demuxLogs", () => {
  test("splits multiplexed stdout/stderr frames into lines", () => {
    const bytes = concat(frame(1, "ready\nlistening"), frame(2, " on 3306\n"), frame(1, "done\n"));
    expect(demuxLogs(bytes)).toEqual(["ready", "listening on 3306", "done"]);
  });

  test("treats non-multiplexed (tty) output as plain text", () => {
    expect(demuxLogs(new TextEncoder().encode("a\r\nb\n"))).toEqual(["a", "b"]);
  });

  test("ignores a truncated trailing frame", () => {
    const full = frame(1, "ok\n");
    const partial = frame(1, "cut off\n").subarray(0, 10);
    expect(demuxLogs(concat(full, partial))).toEqual(["ok"]);
  });

  test("returns no lines for empty output", () => {
    expect(demuxLogs(new Uint8Array())).toEqual([]);
  });
});

describe("createNdjsonParser", () => {
  test("emits objects split across chunk boundaries", () => {
    const seen: unknown[] = [];
    const parser = createNdjsonParser((value) => seen.push(value));
    const enc = new TextEncoder();
    parser.push(enc.encode('{"a":1}\n{"b"'));
    parser.push(enc.encode(":2}\n\n"));
    parser.push(enc.encode('{"c":3}'));
    parser.end();
    expect(seen).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });
});

describe("createPullTracker", () => {
  test("aggregates per-layer byte progress", () => {
    const tracker = createPullTracker();
    tracker.apply({ status: "Pulling from library/mysql", id: "8.4" });
    tracker.apply({ status: "Pulling fs layer", id: "l1" });
    tracker.apply({ status: "Pulling fs layer", id: "l2" });
    tracker.apply({ status: "Downloading", id: "l1", progressDetail: { current: 50, total: 100 } });
    tracker.apply({ status: "Downloading", id: "l2", progressDetail: { current: 10, total: 300 } });
    tracker.apply({ status: "Pull complete", id: "l2" });

    expect(tracker.progress()).toEqual({
      currentBytes: 350,
      totalBytes: 400,
      layersDone: 1,
      layersTotal: 2,
    });
  });

  test("counts already-present layers as done", () => {
    const tracker = createPullTracker();
    tracker.apply({ status: "Already exists", id: "l1" });
    tracker.apply({ status: "Digest: sha256:abc" });
    expect(tracker.progress()).toEqual({
      currentBytes: 0,
      totalBytes: 0,
      layersDone: 1,
      layersTotal: 1,
    });
  });

  test("throws the daemon's error message", () => {
    const tracker = createPullTracker();
    expect(() => tracker.apply({ error: "manifest for mysql:0.1 not found" })).toThrow(
      "manifest for mysql:0.1 not found",
    );
  });
});

describe("computeStats", () => {
  const sample = {
    cpu_stats: {
      cpu_usage: { total_usage: 400_000_000 },
      system_cpu_usage: 20_000_000_000,
      online_cpus: 4,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 200_000_000 },
      system_cpu_usage: 18_000_000_000,
    },
    memory_stats: { usage: 500, limit: 4000, stats: { inactive_file: 100 } },
  };

  test("computes CPU percent across cores and memory minus page cache", () => {
    expect(computeStats(sample)).toEqual({
      cpuPercent: 40,
      memoryBytes: 400,
      memoryLimitBytes: 4000,
    });
  });

  test("reports zero CPU without a previous sample (stopped or first read)", () => {
    const stats = computeStats({
      ...sample,
      precpu_stats: { cpu_usage: { total_usage: 0 } },
      memory_stats: {},
    });
    expect(stats).toEqual({ cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: 0 });
  });
});
