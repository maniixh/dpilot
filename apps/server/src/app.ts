import { type Handler, Hono } from "hono";
import { localRequestGuard } from "./auth/local-request.ts";
import { requireSession, sessionRoutes } from "./auth/session.ts";
import type { DockerClient } from "./docker/types.ts";
import { dockerRoutes } from "./routes/docker.ts";
import { healthRoutes } from "./routes/health.ts";

export interface AppDeps {
  token: string;
  version: string;
  startedAt: number;
  now: () => number;
  docker: DockerClient;
  /** Serves the web UI; null in dev mode where Vite serves it. */
  staticFiles: Handler | null;
}

export function createApp(deps: AppDeps) {
  const api = new Hono()
    .route("/session", sessionRoutes(deps.token))
    .use(requireSession(deps.token))
    .route("/health", healthRoutes(deps))
    .route("/docker", dockerRoutes(deps.docker))
    .all("*", (c) => c.json({ error: "not_found" }, 404));

  const app = new Hono().use(localRequestGuard()).route("/api", api);

  if (deps.staticFiles) {
    app.get("*", deps.staticFiles);
  }

  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}

export type AppType = ReturnType<typeof createApp>;
