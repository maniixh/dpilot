import { beforeEach, describe, expect, test } from "bun:test";
import type { InstanceSummary } from "@dpilot/shared";
import { DockerApiError } from "../docker/engine-api.ts";
import { FakeEngineApi } from "../testing/fake-engine-api.ts";
import { buildContainerSpec } from "./engine-specs.ts";
import { createInstanceService, InstanceError, type InstanceService } from "./service.ts";

let docker: FakeEngineApi;
let busyPorts: Set<number>;
let service: InstanceService;

beforeEach(() => {
  docker = new FakeEngineApi();
  busyPorts = new Set();
  service = createInstanceService({
    docker,
    isPortFree: async (port) => !busyPorts.has(port),
    generatePassword: () => "generated-pw",
  });
});

function existing(
  name: string,
  overrides: {
    port?: number;
    state?: string;
    health?: "healthy" | "unhealthy" | "starting" | null;
    exitCode?: number;
  } = {},
) {
  return docker.addContainer({
    name: `dpilot-${name}`,
    spec: buildContainerSpec({
      name,
      engine: "mysql",
      version: "8.4",
      port: overrides.port ?? 3306,
      password: "pw",
      database: null,
    }),
    state: overrides.state ?? "running",
    health: overrides.health === undefined ? "healthy" : overrides.health,
    exitCode: overrides.exitCode ?? 0,
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return error instanceof InstanceError ? error.code : `not an InstanceError: ${String(error)}`;
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("create", () => {
  test("pulls a missing image, creates volume and container, and starts it", async () => {
    const created = await service.create({ engine: "postgres", version: "17", name: "shop" });

    expect(created).toMatchObject({ name: "shop", engine: "postgres", version: "17", port: 5432 });
    await service.settled("shop");

    expect(docker.calls).toEqual([
      "imageExists postgres:17",
      "pullImage postgres:17",
      "createVolume dpilot_shop_data",
      "createContainer dpilot-shop",
      "startContainer c1",
    ]);
    const container = docker.containers.get("dpilot-shop");
    expect(container?.spec).toEqual(
      buildContainerSpec({
        name: "shop",
        engine: "postgres",
        version: "17",
        port: 5432,
        password: "generated-pw",
        database: null,
      }),
    );
    expect(docker.volumes.get("dpilot_shop_data")).toEqual({
      "dpilot.managed": "true",
      "dpilot.instance": "shop",
    });
    expect((await service.list()).map((i) => i.state)).toEqual([{ status: "starting" }]);
  });

  test("skips the pull when the image is already present and uses the given password", async () => {
    docker.images.add("mysql:8.4");

    await service.create({ engine: "mysql", version: "8.4", name: "a1", password: "my-secret" });
    await service.settled("a1");

    expect(docker.calls).not.toContain("pullImage mysql:8.4");
    expect(docker.containers.get("dpilot-a1")?.spec.Env).toEqual(["MYSQL_ROOT_PASSWORD=my-secret"]);
  });

  test("creates the requested first database and connects to it", async () => {
    docker.images.add("postgres:17");

    await service.create({ engine: "postgres", version: "17", name: "shop", database: "orders" });
    await service.settled("shop");

    expect(docker.containers.get("dpilot-shop")?.spec.Env).toContain("POSTGRES_DB=orders");
    expect((await service.get("shop")).connection).toMatchObject({
      database: "orders",
      url: "postgres://postgres:generated-pw@127.0.0.1:5432/orders",
    });
  });

  test("reports pulling progress while the image downloads", async () => {
    const gate = deferred();
    docker.pullGate = gate.promise;

    await service.create({ engine: "mysql", version: "8.4", name: "shop" });
    await Bun.sleep(0);
    const listed = await service.list();
    gate.resolve();
    await service.settled("shop");

    expect(listed[0]?.state).toEqual({
      status: "pulling",
      progress: { currentBytes: 5, totalBytes: 10, layersDone: 0, layersTotal: 1 },
    });
  });

  test("picks the next port not used by another instance or another program", async () => {
    existing("one", { port: 3306 });
    busyPorts.add(3307);

    const created = await service.create({ engine: "mariadb", version: "11.4", name: "two" });

    expect(created.port).toBe(3308);
  });

  test("does not hand the same port to two concurrent creates", async () => {
    const gate = deferred();
    docker.pullGate = gate.promise;

    const [a, b] = await Promise.all([
      service.create({ engine: "mysql", version: "8.4", name: "aa" }),
      service.create({ engine: "mysql", version: "8.4", name: "bb" }),
    ]);
    gate.resolve();

    expect(new Set([a.port, b.port]).size).toBe(2);
  });

  test("rejects an explicit port held by an instance or another program", async () => {
    existing("one", { port: 3306 });
    busyPorts.add(4000);

    expect(
      await codeOf(service.create({ engine: "mysql", version: "8.4", name: "b1", port: 3306 })),
    ).toBe("conflict");
    expect(
      await codeOf(service.create({ engine: "mysql", version: "8.4", name: "b2", port: 4000 })),
    ).toBe("conflict");
  });

  test("rejects a name that is taken by an instance, an active job, or a leftover volume", async () => {
    existing("taken");
    const gate = deferred();
    docker.pullGate = gate.promise;
    await service.create({ engine: "mysql", version: "8.4", name: "busy" });
    docker.volumes.set("dpilot_old_data", {});

    const req = { engine: "mysql", version: "8.4" } as const;
    expect(await codeOf(service.create({ ...req, name: "taken" }))).toBe("conflict");
    expect(await codeOf(service.create({ ...req, name: "busy" }))).toBe("conflict");
    expect(await codeOf(service.create({ ...req, name: "old" }))).toBe("conflict");
    gate.resolve();
  });

  test("a failed pull leaves a failed entry and no Docker resources", async () => {
    docker.pullError = "manifest unknown";

    await service.create({ engine: "mysql", version: "0.0", name: "bad" });
    await service.settled("bad");

    expect((await service.list())[0]?.state).toEqual({
      status: "failed",
      error: "manifest unknown",
    });
    expect(docker.volumes.size).toBe(0);
    expect(docker.containers.size).toBe(0);
  });

  test("a failed container start removes the container and the new volume", async () => {
    docker.images.add("mysql:8.4");
    docker.startError = new DockerApiError(500, "port is already allocated");

    await service.create({ engine: "mysql", version: "8.4", name: "bad" });
    await service.settled("bad");

    expect((await service.get("bad")).state).toEqual({
      status: "failed",
      error: "port is already allocated",
    });
    expect(docker.volumes.size).toBe(0);
    expect(docker.containers.size).toBe(0);
  });

  test("a failed entry can be removed and the name reused", async () => {
    docker.pullError = "boom";
    await service.create({ engine: "mysql", version: "8.4", name: "again" });
    await service.settled("again");

    await service.remove("again", { removeVolume: false });
    expect(await service.list()).toEqual([]);

    docker.pullError = null;
    await service.create({ engine: "mysql", version: "8.4", name: "again" });
    await service.settled("again");
    expect(docker.containers.has("dpilot-again")).toBe(true);
  });
});

describe("list and get", () => {
  test.each([
    [{ state: "running", health: "healthy" as const }, { status: "ready" }],
    [{ state: "running", health: "starting" as const }, { status: "starting" }],
    [{ state: "running", health: "unhealthy" as const }, { status: "unhealthy" }],
    [{ state: "running", health: null }, { status: "ready" }],
    [
      { state: "exited", health: null, exitCode: 137 },
      { status: "stopped", exitCode: 137 },
    ],
    [
      { state: "created", health: null },
      { status: "stopped", exitCode: null },
    ],
    [{ state: "restarting", health: null }, { status: "restarting" }],
    [{ state: "paused", health: null }, { status: "paused" }],
    [{ state: "dead", health: null }, { status: "dead" }],
  ])("maps container %o to %o", async (container, state) => {
    existing("shop", container);

    const [listed] = await service.list();
    const detail = await service.get("shop");

    expect(listed?.state).toEqual(state as InstanceSummary["state"]);
    expect(detail.state).toEqual(state as InstanceSummary["state"]);
  });

  test("lists instances sorted by name with identity from labels", async () => {
    existing("zeta", { port: 3310 });
    existing("alpha", { port: 3311 });

    expect((await service.list()).map((i) => [i.name, i.engine, i.version, i.port])).toEqual([
      ["alpha", "mysql", "8.4", 3311],
      ["zeta", "mysql", "8.4", 3310],
    ]);
  });

  test("ignores managed containers with labels it cannot read", async () => {
    const c = existing("ok");
    docker.addContainer({
      ...c,
      name: "dpilot-weird",
      spec: {
        ...c.spec,
        Labels: { ...c.spec.Labels, "dpilot.engine": "oracle", "dpilot.instance": "weird" },
      },
    });

    expect((await service.list()).map((i) => i.name)).toEqual(["ok"]);
  });

  test("get returns connection details recovered from the container", async () => {
    existing("shop", { port: 3307 });

    expect(await service.get("shop")).toMatchObject({
      name: "shop",
      image: "mysql:8.4",
      volume: "dpilot_shop_data",
      containerId: "c1",
      connection: {
        host: "127.0.0.1",
        port: 3307,
        user: "root",
        password: "pw",
        url: "mysql://root:pw@127.0.0.1:3307",
      },
    });
  });

  test("get rejects unknown, invalid, and unmanaged names as not_found", async () => {
    const c = existing("real");
    docker.addContainer({ ...c, name: "dpilot-other", spec: { ...c.spec, Labels: {} } });

    expect(await codeOf(service.get("missing"))).toBe("not_found");
    expect(await codeOf(service.get("../etc"))).toBe("not_found");
    expect(await codeOf(service.get("other"))).toBe("not_found");
  });
});

describe("lifecycle", () => {
  test("start, stop and restart act on the instance's container", async () => {
    const c = existing("shop", { state: "exited", health: null });

    await service.start("shop");
    await service.stop("shop");
    await service.restart("shop");

    expect(docker.calls).toEqual([
      `startContainer ${c.id}`,
      `stopContainer ${c.id}`,
      `restartContainer ${c.id}`,
    ]);
  });

  test("actions on an instance that is still being created are conflicts", async () => {
    const gate = deferred();
    docker.pullGate = gate.promise;
    await service.create({ engine: "mysql", version: "8.4", name: "busy" });

    expect(await codeOf(service.stop("busy"))).toBe("conflict");
    expect(await codeOf(service.remove("busy", { removeVolume: true }))).toBe("conflict");
    gate.resolve();
  });

  test("remove keeps the data volume unless asked to delete it", async () => {
    existing("keep");
    docker.volumes.set("dpilot_keep_data", {});
    existing("drop", { port: 3307 });
    docker.volumes.set("dpilot_drop_data", {});

    await service.remove("keep", { removeVolume: false });
    await service.remove("drop", { removeVolume: true });

    expect(docker.containers.size).toBe(0);
    expect([...docker.volumes.keys()]).toEqual(["dpilot_keep_data"]);
  });

  test("remove tolerates a volume that is already gone", async () => {
    existing("shop");

    await service.remove("shop", { removeVolume: true });

    expect(docker.containers.size).toBe(0);
  });
});

describe("logs, stats, compose", () => {
  test("logs returns the tail of the container output", async () => {
    existing("shop");
    docker.logLines = ["a", "b", "c"];

    expect(await service.logs("shop", 2)).toEqual({ lines: ["b", "c"] });
  });

  test("stats samples running instances and reports zeros for stopped ones", async () => {
    existing("up");
    existing("down", { port: 3307, state: "exited", health: null });

    expect(await service.stats("up")).toEqual(docker.statsSample);
    expect(await service.stats("down")).toEqual({
      cpuPercent: 0,
      memoryBytes: 0,
      memoryLimitBytes: 0,
    });
    expect(docker.calls.filter((c) => c.startsWith("containerStats"))).toHaveLength(1);
  });

  test("compose exports the instance with its password", async () => {
    existing("shop", { port: 3307 });

    const compose = await service.compose("shop");

    expect(compose.fileName).toBe("dpilot-shop.compose.yml");
    expect(compose.yaml).toContain('MYSQL_ROOT_PASSWORD: "pw"');
    expect(compose.yaml).toContain('"127.0.0.1:3307:3306"');
  });
});
