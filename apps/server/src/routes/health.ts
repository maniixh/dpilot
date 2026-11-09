import type { HealthResponse } from "@dpilot/shared";
import { Hono } from "hono";

export interface HealthRouteDeps {
  version: string;
  startedAt: number;
  now: () => number;
}

export function healthRoutes(deps: HealthRouteDeps) {
  return new Hono().get("/", (c) =>
    c.json({
      status: "ok",
      version: deps.version,
      uptimeSeconds: Math.floor((deps.now() - deps.startedAt) / 1000),
    } satisfies HealthResponse),
  );
}
