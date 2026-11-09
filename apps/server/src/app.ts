import { type Context, type Handler, Hono } from "hono";
import { localRequestGuard } from "./auth/local-request.ts";
import { requireSession, sessionRoutes } from "./auth/session.ts";
import type { VersionSource } from "./catalog/versions.ts";
import { DockerApiError } from "./docker/engine-api.ts";
import { type DockerClient, DockerTimeoutError, DockerUnavailableError } from "./docker/types.ts";
import { InstanceError, type InstanceService } from "./instances/service.ts";
import { catalogRoutes } from "./routes/catalog.ts";
import { dockerRoutes } from "./routes/docker.ts";
import { healthRoutes } from "./routes/health.ts";
import { instanceRoutes } from "./routes/instances.ts";

export interface AppDeps {
  token: string;
  version: string;
  startedAt: number;
  now: () => number;
  docker: DockerClient;
  instances: InstanceService;
  versions: VersionSource;
  /** Serves the web UI; null in dev mode where Vite serves it. */
  staticFiles: Handler | null;
}

export function createApp(deps: AppDeps) {
  const api = new Hono()
    .route("/session", sessionRoutes(deps.token))
    .use(requireSession(deps.token))
    .route("/health", healthRoutes(deps))
    .route("/docker", dockerRoutes(deps.docker))
    .route("/catalog", catalogRoutes(deps.versions))
    .route("/instances", instanceRoutes(deps.instances))
    .all("*", (c) => c.json({ error: "not_found" }, 404));

  const app = new Hono().use(localRequestGuard()).route("/api", api);

  if (deps.staticFiles) {
    app.get("*", deps.staticFiles);
  }

  app.onError(errorResponse);

  return app;
}

/** Known failures carry a user-facing message; anything else stays a generic 500. */
function errorResponse(error: Error, c: Context) {
  if (error instanceof InstanceError) {
    return c.json(
      { error: error.code, message: error.message },
      error.code === "not_found" ? 404 : 409,
    );
  }
  if (error instanceof DockerUnavailableError) {
    return c.json({ error: "docker_unavailable", message: error.message }, 503);
  }
  if (error instanceof DockerTimeoutError) {
    return c.json({ error: "docker_timeout", message: error.message }, 504);
  }
  if (error instanceof DockerApiError) {
    return c.json({ error: "docker_error", message: error.message }, 502);
  }
  console.error(error);
  return c.json({ error: "internal_error" }, 500);
}

export type AppType = ReturnType<typeof createApp>;
