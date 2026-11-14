import type { TargetErrorCode } from "@dpilot/shared";
import { type Context, type Handler, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { localRequestGuard } from "./auth/local-request.ts";
import { requireSession, sessionRoutes } from "./auth/session.ts";
import type { VersionSource } from "./catalog/versions.ts";
import {
  ConnectionError,
  type ConnectionErrorCode,
  type ConnectionService,
} from "./connections/types.ts";
import { DockerApiError } from "./docker/engine-api.ts";
import { type DockerClient, DockerTimeoutError, DockerUnavailableError } from "./docker/types.ts";
import { TargetError } from "./engines/types.ts";
import type { Explorer } from "./explorer/types.ts";
import { InstanceError, type InstanceService } from "./instances/service.ts";
import { catalogRoutes } from "./routes/catalog.ts";
import { connectionRoutes } from "./routes/connections.ts";
import { dockerRoutes } from "./routes/docker.ts";
import { explorerRoutes } from "./routes/explorer.ts";
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
  connections: ConnectionService;
  explorer: Explorer;
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
    .route("/connections", connectionRoutes(deps.connections, deps.explorer))
    .get("/targets", async (c) => c.json(await deps.explorer.targets()))
    .route("/c", explorerRoutes(deps.explorer))
    .all("*", (c) => c.json({ error: "not_found" }, 404));

  const app = new Hono().use(localRequestGuard()).route("/api", api);

  if (deps.staticFiles) {
    app.get("*", deps.staticFiles);
  }

  app.onError(errorResponse);

  return app;
}

const CONNECTION_STATUS = {
  not_found: 404,
  label_taken: 409,
  password_required: 400,
  password_lost: 409,
  key_mismatch: 409,
} as const satisfies Record<ConnectionErrorCode, ContentfulStatusCode>;

const TARGET_STATUS = {
  target_not_found: 404,
  target_unavailable: 409,
  password_lost: 409,
  auth_failed: 502,
  unreachable: 502,
  tls_failed: 502,
  query_failed: 502,
  timeout: 504,
} as const satisfies Record<TargetErrorCode, ContentfulStatusCode>;

/** Known failures carry a user-facing message; anything else stays a generic 500. */
function errorResponse(error: Error, c: Context) {
  if (error instanceof InstanceError) {
    return c.json(
      { error: error.code, message: error.message },
      error.code === "not_found" ? 404 : 409,
    );
  }
  if (error instanceof ConnectionError) {
    return c.json(
      { error: error.code, message: error.message },
      CONNECTION_STATUS[error.code],
    );
  }
  if (error instanceof TargetError) {
    return c.json({ error: error.code, message: error.message }, TARGET_STATUS[error.code]);
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
