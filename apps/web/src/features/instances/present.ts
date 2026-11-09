import type { InstanceState, InstanceStatus, PullProgress } from "@dpilot/shared";
import { ApiError } from "../../api/client.ts";

export type Tone = "ok" | "busy" | "idle" | "down";

export type InstanceAction = "start" | "stop" | "restart";

const ACTION_STATES: Record<InstanceAction, ReadonlySet<InstanceStatus>> = {
  start: new Set(["stopped", "dead"]),
  // Not while "starting": interrupting first-time initialisation can break the data directory.
  stop: new Set(["ready", "unhealthy", "restarting", "paused"]),
  restart: new Set(["ready", "unhealthy"]),
};

export function availableActions(status: InstanceStatus): InstanceAction[] {
  return (Object.keys(ACTION_STATES) as InstanceAction[]).filter((action) =>
    ACTION_STATES[action].has(status),
  );
}

const SETTLING_POLL_MS = 1500;
const IDLE_POLL_MS = 5000;

/** Refetch interval for instance queries; only a missing instance or session stops polling. */
export function pollInterval(states: InstanceState[] | undefined, error: unknown): number | false {
  if (error instanceof ApiError && (error.status === 401 || error.status === 404)) return false;
  return states?.some(isSettling) ? SETTLING_POLL_MS : IDLE_POLL_MS;
}

export function describeState(state: InstanceState): { label: string; tone: Tone } {
  switch (state.status) {
    case "pulling": {
      const percent = pullPercent(state.progress);
      return {
        label: percent === null ? "Downloading image" : `Downloading image, ${percent}%`,
        tone: "busy",
      };
    }
    case "creating":
      return { label: "Creating container", tone: "busy" };
    case "starting":
      return { label: "Starting", tone: "busy" };
    case "restarting":
      return { label: "Restarting", tone: "busy" };
    case "ready":
      return { label: "Ready", tone: "ok" };
    case "stopped":
      return state.exitCode === null || state.exitCode === 0
        ? { label: "Stopped", tone: "idle" }
        : { label: `Stopped with exit code ${state.exitCode}`, tone: "down" };
    case "paused":
      return { label: "Paused", tone: "idle" };
    case "unhealthy":
      return { label: "Not responding", tone: "down" };
    case "failed":
      return { label: "Couldn't be created", tone: "down" };
    case "dead":
      return { label: "Crashed", tone: "down" };
  }
}

const SETTLING = new Set<InstanceState["status"]>([
  "pulling",
  "creating",
  "starting",
  "restarting",
]);

/** True while the state is expected to change on its own, so the UI should poll quickly. */
export function isSettling(state: InstanceState): boolean {
  return SETTLING.has(state.status);
}

export function pullPercent(progress: PullProgress): number | null {
  if (progress.totalBytes <= 0) return null;
  return Math.min(100, Math.floor((progress.currentBytes / progress.totalBytes) * 100));
}

const UNITS = ["KiB", "MiB", "GiB", "TiB"];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[unit]}`;
}
