import { describe, expect, test } from "bun:test";
import type { DockerStatus } from "@dpilot/shared";
import { shellView } from "./shell.ts";

const running: DockerStatus = {
  state: "running",
  endpoint: "npipe:////./pipe/docker_engine",
  version: "29.7.2",
  apiVersion: "1.55",
  os: "linux",
  arch: "amd64",
};
const unreachable: DockerStatus = {
  state: "unreachable",
  triedEndpoints: ["npipe:////./pipe/docker_engine"],
  reason: "pipe not found",
};

describe("shellView", () => {
  test("shows the app once Docker runs and the status screen before that", () => {
    expect(shellView(running, false)).toBe("app");
    expect(shellView(undefined, false)).toBe("status");
    expect(shellView(unreachable, false)).toBe("status");
  });

  test("keeps the app mounted with a warning when Docker drops out after running", () => {
    expect(shellView(unreachable, true)).toBe("app-docker-lost");
    expect(shellView(undefined, true)).toBe("app");
  });
});
