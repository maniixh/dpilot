import type { InstanceStats, PullProgress } from "@dpilot/shared";
import {
  type ContainerCreateSpec,
  type ContainerDetails,
  type ContainerSummary,
  DockerApiError,
  type DockerEngineApi,
} from "../docker/engine-api.ts";

export interface FakeContainer {
  id: string;
  name: string;
  spec: ContainerCreateSpec;
  /** created | running | exited | paused | restarting | dead */
  state: string;
  health: "starting" | "healthy" | "unhealthy" | null;
  exitCode: number;
}

/** In-memory Docker Engine with hooks for failure injection; models only what Dpilot uses. */
export class FakeEngineApi implements DockerEngineApi {
  images = new Set<string>();
  volumes = new Map<string, Record<string, string>>();
  containers = new Map<string, FakeContainer>();
  calls: string[] = [];
  /** Awaited inside pullImage after the first progress event; lets tests observe "pulling". */
  pullGate: Promise<void> | null = null;
  pullError: string | null = null;
  createContainerError: DockerApiError | null = null;
  startError: DockerApiError | null = null;
  logLines: string[] = [];
  statsSample: InstanceStats = { cpuPercent: 1.5, memoryBytes: 100, memoryLimitBytes: 1000 };
  private nextId = 1;

  /** Adds a container as if created earlier, e.g. by a previous Dpilot run. */
  addContainer(container: Omit<FakeContainer, "id">): FakeContainer {
    const full = { ...container, id: `c${this.nextId++}` };
    this.containers.set(full.name, full);
    return full;
  }

  async imageExists(ref: string): Promise<boolean> {
    this.calls.push(`imageExists ${ref}`);
    return this.images.has(ref);
  }

  async pullImage(
    image: string,
    tag: string,
    onProgress: (progress: PullProgress) => void,
  ): Promise<void> {
    this.calls.push(`pullImage ${image}:${tag}`);
    onProgress({ currentBytes: 5, totalBytes: 10, layersDone: 0, layersTotal: 1 });
    if (this.pullGate) await this.pullGate;
    if (this.pullError) throw new Error(this.pullError);
    this.images.add(`${image}:${tag}`);
  }

  async volumeExists(name: string): Promise<boolean> {
    return this.volumes.has(name);
  }

  async createVolume(name: string, labels: Record<string, string>): Promise<void> {
    this.calls.push(`createVolume ${name}`);
    if (this.volumes.has(name)) throw new DockerApiError(409, "volume exists");
    this.volumes.set(name, labels);
  }

  async removeVolume(name: string): Promise<void> {
    this.calls.push(`removeVolume ${name}`);
    if (!this.volumes.delete(name)) throw new DockerApiError(404, "no such volume");
  }

  async listContainers(labelFilter: string): Promise<ContainerSummary[]> {
    const [key, value] = labelFilter.split("=");
    return [...this.containers.values()]
      .filter((c) => key !== undefined && c.spec.Labels[key] === value)
      .map((c) => ({
        id: c.id,
        image: c.spec.Image,
        state: c.state,
        status: statusText(c),
        labels: c.spec.Labels,
      }));
  }

  async createContainer(name: string, spec: ContainerCreateSpec): Promise<string> {
    this.calls.push(`createContainer ${name}`);
    if (this.createContainerError) throw this.createContainerError;
    if (this.containers.has(name)) throw new DockerApiError(409, "name in use");
    return this.addContainer({ name, spec, state: "created", health: null, exitCode: 0 }).id;
  }

  async inspectContainer(nameOrId: string): Promise<ContainerDetails | null> {
    const c = this.find(nameOrId);
    if (!c) return null;
    return {
      id: c.id,
      name: c.name,
      createdAt: "2025-01-01T00:00:00Z",
      image: c.spec.Image,
      env: Object.fromEntries(
        c.spec.Env.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]),
      ),
      labels: c.spec.Labels,
      state: { status: c.state, exitCode: c.exitCode, health: c.health },
    };
  }

  async startContainer(id: string): Promise<void> {
    this.calls.push(`startContainer ${id}`);
    if (this.startError) throw this.startError;
    const c = this.mustFind(id);
    c.state = "running";
    c.health = c.spec.Healthcheck ? "starting" : null;
  }

  async stopContainer(id: string): Promise<void> {
    this.calls.push(`stopContainer ${id}`);
    const c = this.mustFind(id);
    c.state = "exited";
    c.health = null;
  }

  async restartContainer(id: string): Promise<void> {
    this.calls.push(`restartContainer ${id}`);
    this.mustFind(id).state = "running";
  }

  async removeContainer(id: string): Promise<void> {
    this.calls.push(`removeContainer ${id}`);
    const c = this.mustFind(id);
    this.containers.delete(c.name);
  }

  async containerLogs(id: string, tail: number): Promise<string[]> {
    this.calls.push(`containerLogs ${id} ${tail}`);
    return this.logLines.slice(-tail);
  }

  async containerStats(id: string): Promise<InstanceStats> {
    this.calls.push(`containerStats ${id}`);
    return this.statsSample;
  }

  private find(nameOrId: string): FakeContainer | undefined {
    return (
      this.containers.get(nameOrId) ?? [...this.containers.values()].find((c) => c.id === nameOrId)
    );
  }

  private mustFind(nameOrId: string): FakeContainer {
    const c = this.find(nameOrId);
    if (!c) throw new DockerApiError(404, "no such container");
    return c;
  }
}

function statusText(c: FakeContainer): string {
  if (c.state === "exited") return `Exited (${c.exitCode}) 1 minute ago`;
  if (c.state === "created") return "Created";
  const health = c.health === "starting" ? " (health: starting)" : c.health ? ` (${c.health})` : "";
  return `Up 1 minute${health}`;
}
