import {
  type CreateInstanceRequest,
  type EngineId,
  engineIdSchema,
  getEngine,
  type InstanceCompose,
  type InstanceDetail,
  type InstanceLogs,
  type InstanceState,
  type InstanceStats,
  type InstanceSummary,
  imageTagSchema,
  instanceNameSchema,
} from "@dpilot/shared";
import { z } from "zod";
import {
  type ContainerDetails,
  DockerApiError,
  type DockerEngineApi,
} from "../docker/engine-api.ts";
import { composeYaml } from "./compose.ts";
import {
  buildContainerSpec,
  connectionFor,
  containerName,
  engineSpec,
  type InstanceIdentity,
  type InstanceSettings,
  imageRef,
  LABEL,
  volumeName,
} from "./engine-specs.ts";

export type InstanceErrorCode = "not_found" | "conflict";

export class InstanceError extends Error {
  override name = "InstanceError";
  constructor(
    readonly code: InstanceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface InstanceServiceDeps {
  docker: DockerEngineApi;
  /** True when nothing on this machine listens on 127.0.0.1:port. */
  isPortFree(port: number): Promise<boolean>;
  generatePassword(): string;
}

export interface InstanceService {
  list(): Promise<InstanceSummary[]>;
  get(name: string): Promise<InstanceDetail>;
  /** Validates, then provisions in the background; poll list/get for progress. */
  create(request: CreateInstanceRequest): Promise<InstanceSummary>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  remove(name: string, options: { removeVolume: boolean }): Promise<void>;
  logs(name: string, tail: number): Promise<InstanceLogs>;
  stats(name: string): Promise<InstanceStats>;
  compose(name: string): Promise<InstanceCompose>;
  /** Resolves once the named provisioning job (if any) has finished. */
  settled(name: string): Promise<void>;
}

interface Job extends InstanceSettings {
  state: InstanceState;
  done: Promise<void>;
}

const PORT_SEARCH_RANGE = 100;
const ZERO_STATS: InstanceStats = { cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: 0 };

const labelsSchema = z.object({
  [LABEL.managed]: z.literal("true"),
  [LABEL.instance]: instanceNameSchema,
  [LABEL.engine]: engineIdSchema,
  [LABEL.version]: imageTagSchema,
  [LABEL.port]: z.coerce.number().int().min(1).max(65535),
});

function identityFromLabels(labels: Record<string, string>): InstanceIdentity | null {
  const parsed = labelsSchema.safeParse(labels);
  if (!parsed.success) return null;
  return {
    name: parsed.data[LABEL.instance],
    engine: parsed.data[LABEL.engine],
    version: parsed.data[LABEL.version],
    port: parsed.data[LABEL.port],
  };
}

export function containerState(
  status: string,
  health: string | null,
  exitCode: number | null,
): InstanceState {
  switch (status) {
    case "running":
      if (health === "starting") return { status: "starting" };
      if (health === "unhealthy") return { status: "unhealthy" };
      return { status: "ready" };
    case "exited":
      return { status: "stopped", exitCode };
    case "created":
      return { status: "stopped", exitCode: null };
    case "restarting":
      return { status: "restarting" };
    case "paused":
      return { status: "paused" };
    default:
      return { status: "dead" };
  }
}

/** Health and exit code from `docker ps` status text, e.g. "Up 2 minutes (healthy)", "Exited (0) 1 hour ago". */
function stateFromListStatus(state: string, statusText: string): InstanceState {
  const health = /\((healthy|unhealthy|health: starting)\)/.exec(statusText)?.[1] ?? null;
  const exit = /^Exited \((-?\d+)\)/.exec(statusText)?.[1];
  return containerState(
    state,
    health === "health: starting" ? "starting" : health,
    exit === undefined ? null : Number(exit),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createInstanceService(deps: InstanceServiceDeps): InstanceService {
  const { docker } = deps;
  const jobs = new Map<string, Job>();
  /** Serializes create admission so concurrent requests cannot claim the same name or port. */
  let admission: Promise<unknown> = Promise.resolve();

  function activeJob(name: string): Job | undefined {
    const job = jobs.get(name);
    return job && job.state.status !== "failed" ? job : undefined;
  }

  function assertNotProvisioning(name: string): void {
    if (activeJob(name)) {
      throw new InstanceError("conflict", `Instance "${name}" is still being created`);
    }
  }

  async function managedInstances(): Promise<
    { identity: InstanceIdentity; state: InstanceState }[]
  > {
    const containers = await docker.listContainers(`${LABEL.managed}=true`);
    return containers.flatMap((c) => {
      const identity = identityFromLabels(c.labels);
      return identity ? [{ identity, state: stateFromListStatus(c.state, c.status) }] : [];
    });
  }

  async function findContainer(
    name: string,
  ): Promise<{ details: ContainerDetails; identity: InstanceIdentity }> {
    const notFound = new InstanceError("not_found", `No instance named "${name}"`);
    if (!instanceNameSchema.safeParse(name).success) throw notFound;
    const details = await docker.inspectContainer(containerName(name));
    const identity = details ? identityFromLabels(details.labels) : null;
    if (!details || !identity || identity.name !== name) throw notFound;
    return { details, identity };
  }

  async function choosePort(engine: EngineId, requested: number | undefined): Promise<number> {
    const taken = new Set<number>([
      ...(await managedInstances()).map((i) => i.identity.port),
      ...[...jobs.values()].filter((j) => j.state.status !== "failed").map((j) => j.port),
    ]);
    if (requested !== undefined) {
      if (taken.has(requested)) {
        throw new InstanceError("conflict", `Port ${requested} is used by another Dpilot instance`);
      }
      if (!(await deps.isPortFree(requested))) {
        throw new InstanceError("conflict", `Port ${requested} is in use by another program`);
      }
      return requested;
    }
    const first = getEngine(engine).defaultPort;
    for (let port = first; port < first + PORT_SEARCH_RANGE && port <= 65535; port++) {
      if (!taken.has(port) && (await deps.isPortFree(port))) return port;
    }
    throw new InstanceError(
      "conflict",
      `No free port found between ${first} and ${first + PORT_SEARCH_RANGE - 1}`,
    );
  }

  async function admit(request: CreateInstanceRequest): Promise<Job> {
    const { name, engine, version } = request;
    if (activeJob(name) || (await docker.inspectContainer(containerName(name)))) {
      throw new InstanceError("conflict", `An instance named "${name}" already exists`);
    }
    if (await docker.volumeExists(volumeName(name))) {
      throw new InstanceError(
        "conflict",
        `A data volume named ${volumeName(name)} already exists. Remove it or choose another name.`,
      );
    }
    const port = await choosePort(engine, request.port);
    const job: Job = {
      name,
      engine,
      version,
      port,
      password: request.password ?? deps.generatePassword(),
      database: request.database ?? null,
      state: { status: "creating" },
      done: Promise.resolve(),
    };
    jobs.set(name, job);
    return job;
  }

  async function provision(job: Job): Promise<void> {
    const image = imageRef(job.engine, job.version);
    let containerId: string | null = null;
    let createdVolume = false;
    try {
      if (!(await docker.imageExists(image))) {
        job.state = {
          status: "pulling",
          progress: { currentBytes: 0, totalBytes: 0, layersDone: 0, layersTotal: 0 },
        };
        await docker.pullImage(getEngine(job.engine).image, job.version, (progress) => {
          job.state = { status: "pulling", progress };
        });
      }
      job.state = { status: "creating" };
      await docker.createVolume(volumeName(job.name), {
        [LABEL.managed]: "true",
        [LABEL.instance]: job.name,
      });
      createdVolume = true;
      containerId = await docker.createContainer(containerName(job.name), buildContainerSpec(job));
      await docker.startContainer(containerId);
      jobs.delete(job.name);
    } catch (error) {
      job.state = { status: "failed", error: errorMessage(error) };
      if (containerId) await docker.removeContainer(containerId).catch(() => {});
      if (createdVolume) await docker.removeVolume(volumeName(job.name)).catch(() => {});
    }
  }

  function summaryOf(identity: InstanceIdentity, state: InstanceState): InstanceSummary {
    return {
      name: identity.name,
      engine: identity.engine,
      version: identity.version,
      port: identity.port,
      state,
    };
  }

  async function act(name: string, action: (id: string) => Promise<void>): Promise<void> {
    assertNotProvisioning(name);
    const { details } = await findContainer(name);
    await action(details.id);
  }

  async function settingsOf(name: string) {
    const { details, identity } = await findContainer(name);
    const spec = engineSpec(identity.engine);
    const password = spec.passwordFromEnv(details.env) ?? "";
    const database = spec.databaseFromEnv(details.env);
    return { details, identity, password, database };
  }

  return {
    async list() {
      const byName = new Map<string, InstanceSummary>();
      for (const { identity, state } of await managedInstances()) {
        byName.set(identity.name, summaryOf(identity, state));
      }
      for (const job of jobs.values()) byName.set(job.name, summaryOf(job, job.state));
      return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    },

    async get(name) {
      const job = jobs.get(name);
      if (job) {
        return {
          ...summaryOf(job, job.state),
          connection: connectionFor(job.engine, job.port, job.password, job.database),
          image: imageRef(job.engine, job.version),
          volume: volumeName(job.name),
          containerId: null,
          createdAt: null,
        };
      }
      const { details, identity, password, database } = await settingsOf(name);
      return {
        ...summaryOf(
          identity,
          containerState(details.state.status, details.state.health, details.state.exitCode),
        ),
        connection: connectionFor(identity.engine, identity.port, password, database),
        image: details.image,
        volume: volumeName(name),
        containerId: details.id,
        createdAt: details.createdAt,
      };
    },

    async create(request) {
      const admitted = admission.then(() => admit(request));
      admission = admitted.catch(() => {});
      const job = await admitted;
      job.done = provision(job);
      return summaryOf(job, job.state);
    },

    start: (name) => act(name, (id) => docker.startContainer(id)),
    stop: (name) => act(name, (id) => docker.stopContainer(id)),
    restart: (name) => act(name, (id) => docker.restartContainer(id)),

    async remove(name, { removeVolume }) {
      assertNotProvisioning(name);
      if (jobs.has(name)) {
        // A failed job already cleaned up after itself.
        jobs.delete(name);
        return;
      }
      const { details } = await findContainer(name);
      await docker.removeContainer(details.id);
      if (removeVolume) {
        await docker.removeVolume(volumeName(name)).catch((error: unknown) => {
          if (!(error instanceof DockerApiError && error.status === 404)) throw error;
        });
      }
    },

    async logs(name, tail) {
      assertNotProvisioning(name);
      const { details } = await findContainer(name);
      return { lines: await docker.containerLogs(details.id, tail) };
    },

    async stats(name) {
      assertNotProvisioning(name);
      const { details } = await findContainer(name);
      if (details.state.status !== "running") return ZERO_STATS;
      return docker.containerStats(details.id);
    },

    async compose(name) {
      const { identity, password, database } = await settingsOf(name);
      return {
        fileName: `${containerName(name)}.compose.yml`,
        yaml: composeYaml({ ...identity, password, database }),
      };
    },

    async settled(name) {
      await jobs.get(name)?.done;
    },
  };
}
