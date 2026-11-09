import type { InstanceStats, PullProgress } from "@dpilot/shared";
import { z } from "zod";
import { demuxLogs } from "./logs.ts";
import { createNdjsonParser, createPullTracker } from "./pull-progress.ts";
import { computeStats, statsResponseSchema } from "./stats.ts";
import type { DockerCallOptions, DockerConnection, DockerResponse } from "./types.ts";

/** The engine answered with a non-success HTTP status. */
export class DockerApiError extends Error {
  override name = "DockerApiError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ContainerCreateSpec {
  Image: string;
  Env: string[];
  Labels: Record<string, string>;
  ExposedPorts: Record<string, Record<string, never>>;
  Healthcheck?: {
    Test: string[];
    /** Nanoseconds. */
    Interval: number;
    Timeout: number;
    Retries: number;
    StartPeriod: number;
  };
  HostConfig: {
    PortBindings: Record<string, { HostIp: string; HostPort: string }[]>;
    Mounts: { Type: "volume"; Source: string; Target: string }[];
    RestartPolicy: { Name: "no" | "unless-stopped" };
  };
}

export interface ContainerSummary {
  id: string;
  image: string;
  /** created | running | paused | restarting | removing | exited | dead */
  state: string;
  status: string;
  labels: Record<string, string>;
}

export interface ContainerDetails {
  id: string;
  name: string;
  createdAt: string;
  image: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  state: {
    status: string;
    exitCode: number;
    /** starting | healthy | unhealthy, or null without a healthcheck. */
    health: string | null;
  };
}

export interface DockerEngineApi {
  imageExists(ref: string): Promise<boolean>;
  pullImage(
    image: string,
    tag: string,
    onProgress: (progress: PullProgress) => void,
  ): Promise<void>;
  volumeExists(name: string): Promise<boolean>;
  createVolume(name: string, labels: Record<string, string>): Promise<void>;
  removeVolume(name: string): Promise<void>;
  listContainers(labelFilter: string): Promise<ContainerSummary[]>;
  createContainer(name: string, spec: ContainerCreateSpec): Promise<string>;
  inspectContainer(nameOrId: string): Promise<ContainerDetails | null>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string): Promise<void>;
  restartContainer(id: string): Promise<void>;
  removeContainer(id: string): Promise<void>;
  containerLogs(id: string, tail: number): Promise<string[]>;
  containerStats(id: string): Promise<InstanceStats>;
}

const messageSchema = z.object({ message: z.string() });

const containerListSchema = z.array(
  z.object({
    Id: z.string(),
    Image: z.string(),
    State: z.string(),
    Status: z.string(),
    Labels: z.record(z.string(), z.string()).nullable().optional(),
  }),
);

const containerInspectSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Created: z.string(),
  Config: z.object({
    Image: z.string(),
    Env: z.array(z.string()).nullable().optional(),
    Labels: z.record(z.string(), z.string()).nullable().optional(),
  }),
  State: z.object({
    Status: z.string(),
    ExitCode: z.number(),
    Health: z.object({ Status: z.string() }).nullable().optional(),
  }),
});

const createdSchema = z.object({ Id: z.string() });

/**
 * Engine calls can be slow when Docker Desktop wakes from Resource Saver,
 * unlike the quick /version probe used for status.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Docker stops gracefully for this many seconds before killing. */
const STOP_GRACE_SECONDS = 10;
const LIFECYCLE_TIMEOUT_MS = (STOP_GRACE_SECONDS + 20) * 1000;
/** Pulls can pause for a while between progress events on slow registries. */
const PULL_IDLE_TIMEOUT_MS = 120_000;
/** Stats without one-shot waits for a second sample (~1-2s). */
const STATS_TIMEOUT_MS = 10_000;
const LOGS_MAX_BYTES = 4 * 1024 * 1024;

export function createDockerEngineApi(docker: DockerConnection): DockerEngineApi {
  function send(options: DockerCallOptions): Promise<DockerResponse> {
    return docker.request({ idleTimeoutMs: DEFAULT_TIMEOUT_MS, ...options });
  }

  async function call(options: DockerCallOptions, ok: number[] = []): Promise<DockerResponse> {
    const res = await send(options);
    if ((res.status >= 200 && res.status < 300) || ok.includes(res.status)) return res;
    throw new DockerApiError(res.status, daemonMessage(res));
  }

  async function exists(path: string): Promise<boolean> {
    const res = await send({ method: "GET", path });
    if (res.status === 404) return false;
    if (res.status >= 200 && res.status < 300) return true;
    throw new DockerApiError(res.status, daemonMessage(res));
  }

  async function lifecycle(id: string, action: string, query = ""): Promise<void> {
    await call(
      {
        method: "POST",
        path: `/containers/${encodeURIComponent(id)}/${action}${query}`,
        idleTimeoutMs: LIFECYCLE_TIMEOUT_MS,
      },
      [304],
    );
  }

  return {
    imageExists: (ref) => exists(`/images/${encodeURIComponent(ref)}/json`),

    async pullImage(image, tag, onProgress) {
      const tracker = createPullTracker();
      let failure: Error | null = null;
      const parser = createNdjsonParser((event) => {
        if (failure) return;
        try {
          tracker.apply(event);
          onProgress(tracker.progress());
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
      });
      const query = new URLSearchParams({ fromImage: image, tag });
      await call({
        method: "POST",
        path: `/images/create?${query}`,
        idleTimeoutMs: PULL_IDLE_TIMEOUT_MS,
        onData: (chunk) => parser.push(chunk),
      });
      parser.end();
      if (failure) throw failure;
    },

    volumeExists: (name) => exists(`/volumes/${encodeURIComponent(name)}`),

    async createVolume(name, labels) {
      await call({ method: "POST", path: "/volumes/create", body: { Name: name, Labels: labels } });
    },

    async removeVolume(name) {
      await call({ method: "DELETE", path: `/volumes/${encodeURIComponent(name)}` });
    },

    async listContainers(labelFilter) {
      const filters = encodeURIComponent(JSON.stringify({ label: [labelFilter] }));
      const res = await call({
        method: "GET",
        path: `/containers/json?all=true&filters=${filters}`,
      });
      return containerListSchema.parse(parseJson(res)).map((c) => ({
        id: c.Id,
        image: c.Image,
        state: c.State,
        status: c.Status,
        labels: c.Labels ?? {},
      }));
    },

    async createContainer(name, spec) {
      const res = await call({
        method: "POST",
        path: `/containers/create?name=${encodeURIComponent(name)}`,
        body: spec,
      });
      return createdSchema.parse(parseJson(res)).Id;
    },

    async inspectContainer(nameOrId) {
      const res = await send({
        method: "GET",
        path: `/containers/${encodeURIComponent(nameOrId)}/json`,
      });
      if (res.status === 404) return null;
      if (res.status < 200 || res.status >= 300) {
        throw new DockerApiError(res.status, daemonMessage(res));
      }
      const c = containerInspectSchema.parse(parseJson(res));
      return {
        id: c.Id,
        name: c.Name.replace(/^\//, ""),
        createdAt: c.Created,
        image: c.Config.Image,
        env: parseEnv(c.Config.Env ?? []),
        labels: c.Config.Labels ?? {},
        state: {
          status: c.State.Status,
          exitCode: c.State.ExitCode,
          health: c.State.Health?.Status ?? null,
        },
      };
    },

    startContainer: (id) => lifecycle(id, "start"),
    stopContainer: (id) => lifecycle(id, "stop", `?t=${STOP_GRACE_SECONDS}`),
    restartContainer: (id) => lifecycle(id, "restart", `?t=${STOP_GRACE_SECONDS}`),

    async removeContainer(id) {
      await call({
        method: "DELETE",
        path: `/containers/${encodeURIComponent(id)}?force=true`,
        idleTimeoutMs: LIFECYCLE_TIMEOUT_MS,
      });
    },

    async containerLogs(id, tail) {
      const res = await call({
        method: "GET",
        path: `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=${tail}`,
        maxBytes: LOGS_MAX_BYTES,
      });
      return demuxLogs(res.body);
    },

    async containerStats(id) {
      const res = await call({
        method: "GET",
        path: `/containers/${encodeURIComponent(id)}/stats?stream=false`,
        idleTimeoutMs: STATS_TIMEOUT_MS,
      });
      return computeStats(statsResponseSchema.parse(parseJson(res)));
    },
  };
}

function parseJson(res: DockerResponse): unknown {
  return JSON.parse(new TextDecoder().decode(res.body));
}

function daemonMessage(res: DockerResponse): string {
  try {
    const parsed = messageSchema.safeParse(parseJson(res));
    if (parsed.success) return parsed.data.message;
  } catch {
    // Fall through to the generic message.
  }
  return `Docker responded with HTTP ${res.status}`;
}

function parseEnv(entries: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}
