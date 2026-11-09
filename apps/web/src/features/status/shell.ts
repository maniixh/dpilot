import type { DockerStatus } from "@dpilot/shared";

export type ShellView = "app" | "app-docker-lost" | "status";

/**
 * Before Docker has been seen running, the status screen explains how to start it. After that,
 * the app stays mounted through Docker outages so open pages and half-filled forms survive.
 */
export function shellView(docker: DockerStatus | undefined, seenRunning: boolean): ShellView {
  if (docker?.state === "running") return "app";
  if (!seenRunning) return "status";
  return docker?.state === "unreachable" ? "app-docker-lost" : "app";
}
