import type { PullProgress } from "@dpilot/shared";
import { z } from "zod";

/** Splits a newline-delimited JSON byte stream into parsed values. Invalid lines are skipped. */
export function createNdjsonParser(onValue: (value: unknown) => void) {
  const decoder = new TextDecoder();
  let pending = "";

  function flushLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onValue(JSON.parse(trimmed));
    } catch {
      // Docker only emits JSON lines here; ignore anything else.
    }
  }

  return {
    push(chunk: Uint8Array) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) flushLine(line);
    },
    end() {
      pending += decoder.decode();
      flushLine(pending);
      pending = "";
    },
  };
}

const pullEventSchema = z.object({
  status: z.string().optional(),
  id: z.string().optional(),
  error: z.string().optional(),
  progressDetail: z
    .object({ current: z.number().optional(), total: z.number().optional() })
    .optional(),
});

interface LayerProgress {
  current: number;
  total: number;
  done: boolean;
}

const DONE_STATUSES = new Set(["Pull complete", "Already exists", "Download complete"]);

/** Folds `POST /images/create` progress events into one overall progress value. */
export function createPullTracker() {
  const layers = new Map<string, LayerProgress>();

  return {
    /** Throws when the event reports a pull failure. */
    apply(event: unknown): void {
      const parsed = pullEventSchema.safeParse(event);
      if (!parsed.success) return;
      const { status, id, error, progressDetail } = parsed.data;
      if (error) throw new Error(error);
      if (!id || !status || status.startsWith("Pulling from")) return;

      const layer = layers.get(id) ?? { current: 0, total: 0, done: false };
      if (status === "Downloading" && progressDetail?.total) {
        layer.current = progressDetail.current ?? layer.current;
        layer.total = progressDetail.total;
      }
      if (DONE_STATUSES.has(status)) {
        layer.done = true;
        layer.current = layer.total;
      }
      layers.set(id, layer);
    },

    progress(): PullProgress {
      let currentBytes = 0;
      let totalBytes = 0;
      let layersDone = 0;
      for (const layer of layers.values()) {
        currentBytes += layer.current;
        totalBytes += layer.total;
        if (layer.done) layersDone += 1;
      }
      return { currentBytes, totalBytes, layersDone, layersTotal: layers.size };
    },
  };
}
