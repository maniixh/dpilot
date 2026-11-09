import { describe, expect, test } from "bun:test";
import type { InstanceState, InstanceStatus } from "@dpilot/shared";
import { ApiError } from "../../api/client.ts";
import {
  availableActions,
  describeState,
  formatBytes,
  type InstanceAction,
  isSettling,
  pollInterval,
  pullPercent,
  type Tone,
} from "./present.ts";

describe("availableActions", () => {
  test.each<[InstanceStatus, InstanceAction[]]>([
    ["ready", ["stop", "restart"]],
    ["unhealthy", ["stop", "restart"]],
    ["restarting", ["stop"]],
    ["paused", ["stop"]],
    ["stopped", ["start"]],
    ["dead", ["start"]],
    // Stopping during first-time initialisation can leave a half-built data directory.
    ["starting", []],
    ["pulling", []],
    ["creating", []],
    ["failed", []],
  ])("%s offers %o", (status, actions) => {
    expect(availableActions(status)).toEqual(actions);
  });
});

describe("pollInterval", () => {
  const ready: InstanceState = { status: "ready" };
  const starting: InstanceState = { status: "starting" };

  test("polls fast while anything is settling and slowly otherwise", () => {
    expect(pollInterval([ready, starting], null)).toBe(1500);
    expect(pollInterval([ready], null)).toBe(5000);
    expect(pollInterval(undefined, null)).toBe(5000);
  });

  test("keeps polling through transient errors but stops for missing or unauthorised", () => {
    expect(pollInterval([ready], new ApiError(503, "docker_unavailable", "down"))).toBe(5000);
    expect(pollInterval([ready], new TypeError("Failed to fetch"))).toBe(5000);
    expect(pollInterval([ready], new ApiError(404, "not_found", null))).toBe(false);
    expect(pollInterval([ready], new ApiError(401, null, null))).toBe(false);
  });
});

describe("describeState", () => {
  test.each<[InstanceState, string, Tone]>([
    [{ status: "ready" }, "Ready", "ok"],
    [{ status: "starting" }, "Starting", "busy"],
    [{ status: "creating" }, "Creating container", "busy"],
    [{ status: "restarting" }, "Restarting", "busy"],
    [{ status: "stopped", exitCode: 0 }, "Stopped", "idle"],
    [{ status: "stopped", exitCode: null }, "Stopped", "idle"],
    [{ status: "stopped", exitCode: 1 }, "Stopped with exit code 1", "down"],
    [{ status: "paused" }, "Paused", "idle"],
    [{ status: "unhealthy" }, "Not responding", "down"],
    [{ status: "failed", error: "pull denied" }, "Couldn't be created", "down"],
    [{ status: "dead" }, "Crashed", "down"],
  ])("%o reads as %s", (state, label, tone) => {
    expect(describeState(state)).toEqual({ label, tone });
  });

  test("pulling shows download progress when sizes are known", () => {
    const progress = { currentBytes: 50, totalBytes: 200, layersDone: 1, layersTotal: 4 };
    expect(describeState({ status: "pulling", progress })).toEqual({
      label: "Downloading image, 25%",
      tone: "busy",
    });
    expect(
      describeState({ status: "pulling", progress: { ...progress, totalBytes: 0 } }).label,
    ).toBe("Downloading image");
  });
});

describe("isSettling", () => {
  test("is true only while Dpilot or Docker is still moving the instance", () => {
    const settling = ["pulling", "creating", "starting", "restarting"];
    const states: InstanceState[] = [
      {
        status: "pulling",
        progress: { currentBytes: 0, totalBytes: 0, layersDone: 0, layersTotal: 0 },
      },
      { status: "creating" },
      { status: "starting" },
      { status: "restarting" },
      { status: "ready" },
      { status: "stopped", exitCode: 0 },
      { status: "failed", error: "x" },
      { status: "unhealthy" },
    ];
    for (const state of states) {
      expect(isSettling(state)).toBe(settling.includes(state.status));
    }
  });
});

describe("pullPercent", () => {
  test("clamps to 0..100 and is null without a total", () => {
    expect(pullPercent({ currentBytes: 1, totalBytes: 3, layersDone: 0, layersTotal: 1 })).toBe(33);
    expect(pullPercent({ currentBytes: 9, totalBytes: 3, layersDone: 0, layersTotal: 1 })).toBe(
      100,
    );
    expect(
      pullPercent({ currentBytes: 0, totalBytes: 0, layersDone: 0, layersTotal: 0 }),
    ).toBeNull();
  });
});

describe("formatBytes", () => {
  test.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1536, "1.5 KiB"],
    [512 * 1024 * 1024, "512 MiB"],
    [3.25 * 1024 ** 3, "3.3 GiB"],
  ])("%i bytes reads as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
