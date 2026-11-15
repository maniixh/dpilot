import {
  type InstanceStatus,
  parseTargetId,
  type SavedConnection,
  type TargetId,
  type TargetSummary,
  type TargetsResponse,
} from "@dpilot/shared";
import {
  type ConnectionConfig,
  ConnectionError,
  type ConnectionService,
} from "../connections/types.ts";
import { DockerTimeoutError, DockerUnavailableError } from "../docker/types.ts";
import { createAdapter } from "../engines/registry.ts";
import {
  type AdapterContext,
  type ExplorerAdapter,
  type SqlClientFactory,
  TargetError,
} from "../engines/types.ts";
import { InstanceError, type InstanceService } from "../instances/service.ts";
import type { Explorer } from "./types.ts";

export interface ExplorerDeps {
  instances: InstanceService;
  connections: ConnectionService;
  sql: SqlClientFactory;
}

const NOT_FOUND = "No connection or server with that id.";
const DOCKER_DOWN = "Docker isn't reachable, so Dpilot's servers can't be listed.";
const PASSWORD_LOST_REASON = "Enter the password again to browse it.";
/** Failures that mean the session itself is bad, so the cached adapter must go. */
const CONNECTION_FAILURES = new Set(["auth_failed", "unreachable", "tls_failed", "timeout"]);

type Availability = "ready" | "stopped" | "starting" | "unhealthy";

function availability(status: InstanceStatus): Availability {
  switch (status) {
    case "ready":
      return "ready";
    case "stopped":
    case "dead":
    case "paused":
      return "stopped";
    case "pulling":
    case "creating":
    case "starting":
    case "restarting":
      return "starting";
    case "failed":
    case "unhealthy":
      return "unhealthy";
  }
}

const LIST_REASONS: Record<Exclude<Availability, "ready">, string> = {
  stopped: "Stopped. Start it to browse it.",
  starting: "Still starting.",
  unhealthy: "Not healthy. Check its logs.",
};

function unavailableMessage(name: string, state: Exclude<Availability, "ready">): string {
  switch (state) {
    case "stopped":
      return `The server ${name} is stopped. Start it to browse it.`;
    case "starting":
      return `The server ${name} is still starting.`;
    case "unhealthy":
      return `The server ${name} isn't healthy. Check its logs.`;
  }
}

function connectionTarget(saved: SavedConnection): TargetSummary {
  const base = {
    id: `c.${saved.id}`,
    kind: "connection" as const,
    label: saved.label,
    engine: saved.engine,
  };
  return saved.passwordLost
    ? { ...base, available: false, reason: PASSWORD_LOST_REASON }
    : { ...base, available: true };
}

export function createExplorer(deps: ExplorerDeps): Explorer {
  const cache = new Map<TargetId, { fingerprint: string; adapter: ExplorerAdapter }>();

  async function forget(target: TargetId): Promise<void> {
    const entry = cache.get(target);
    cache.delete(target);
    await entry?.adapter.close().catch(() => {});
  }

  async function servers(): Promise<TargetsResponse["servers"]> {
    try {
      const list = await deps.instances.list();
      const targets = list.map((instance): TargetSummary => {
        const base = {
          id: `s.${instance.name}`,
          kind: "server" as const,
          label: instance.name,
          engine: instance.engine,
        };
        const state = availability(instance.state.status);
        return state === "ready"
          ? { ...base, available: true }
          : { ...base, available: false, reason: LIST_REASONS[state] };
      });
      return { status: "ok", targets };
    } catch (error) {
      if (error instanceof DockerUnavailableError || error instanceof DockerTimeoutError) {
        return { status: "unavailable", message: DOCKER_DOWN };
      }
      throw error;
    }
  }

  async function serverConfig(
    target: TargetId,
    name: string,
  ): Promise<{ config: ConnectionConfig; ctx: AdapterContext }> {
    let detail: Awaited<ReturnType<InstanceService["get"]>>;
    try {
      detail = await deps.instances.get(name);
    } catch (error) {
      if (error instanceof InstanceError && error.code === "not_found") {
        await forget(target);
        throw new TargetError("target_not_found", NOT_FOUND);
      }
      throw error;
    }
    const state = availability(detail.state.status);
    if (state !== "ready" || detail.connection === null) {
      await forget(target);
      throw new TargetError(
        "target_unavailable",
        unavailableMessage(name, state === "ready" ? "starting" : state),
      );
    }
    const { connection } = detail;
    return {
      config: {
        engine: detail.engine,
        host: connection.host,
        port: connection.port,
        username: connection.user,
        password: connection.password,
        database: connection.database,
        tls: { mode: "off", ca: null },
        readOnly: false,
      },
      ctx: { managed: true },
    };
  }

  type Resolved = { config: ConnectionConfig; ctx: AdapterContext };

  async function savedConfig(id: string): Promise<Resolved> {
    try {
      return { config: await deps.connections.resolve(id), ctx: { managed: false } };
    } catch (error) {
      if (error instanceof ConnectionError && error.code === "not_found") {
        throw new TargetError("target_not_found", NOT_FOUND);
      }
      if (error instanceof ConnectionError && error.code === "password_lost") {
        throw new TargetError("password_lost", error.message);
      }
      throw error;
    }
  }

  async function adapterFor(target: TargetId): Promise<ExplorerAdapter> {
    const parsed = parseTargetId(target);
    if (parsed === null) throw new TargetError("target_not_found", NOT_FOUND);
    const { config, ctx } =
      parsed.kind === "server"
        ? await serverConfig(target, parsed.name)
        : await savedConfig(parsed.id);
    const fingerprint = JSON.stringify(config);
    const cached = cache.get(target);
    if (cached?.fingerprint === fingerprint) return cached.adapter;
    if (cached) {
      cache.delete(target);
      void cached.adapter.close().catch(() => {});
    }
    const adapter = createAdapter(config, deps.sql, ctx);
    cache.set(target, { fingerprint, adapter });
    return adapter;
  }

  return {
    async targets() {
      const [serverList, saved] = await Promise.all([servers(), deps.connections.list()]);
      return { servers: serverList, connections: saved.map(connectionTarget) };
    },

    async run(target, use) {
      const adapter = await adapterFor(target);
      try {
        return await use(adapter);
      } catch (error) {
        if (error instanceof TargetError && CONNECTION_FAILURES.has(error.code)) {
          if (cache.get(target)?.adapter === adapter) await forget(target);
        }
        throw error;
      }
    },

    async test(request) {
      const config = await deps.connections.draft(request);
      const adapter = createAdapter(config, deps.sql, { managed: false });
      try {
        return { ok: true, info: await adapter.info() };
      } catch (error) {
        if (error instanceof TargetError) {
          return { ok: false, code: error.code, message: error.message };
        }
        throw error;
      } finally {
        await adapter.close().catch(() => {});
      }
    },

    forget,
  };
}
