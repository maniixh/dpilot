import { afterEach, describe, expect, test } from "bun:test";
import {
  closeFakeEngines,
  type FakeHandler,
  type FakeRequest,
  json,
  startFakeEngine,
} from "../testing/fake-docker-engine.ts";
import { createDockerClient } from "./client.ts";
import { type ContainerCreateSpec, createDockerEngineApi, DockerApiError } from "./engine-api.ts";

afterEach(closeFakeEngines);

const versionBody = { Version: "29.0.0", ApiVersion: "1.52", Os: "linux", Arch: "amd64" };

async function apiWith(handler: FakeHandler) {
  const engine = await startFakeEngine((req) =>
    req.path === "/version" ? json(200, versionBody) : handler(req),
  );
  const client = createDockerClient({ resolveEndpoints: () => [engine.endpoint], timeoutMs: 2000 });
  const api = createDockerEngineApi(client);
  const calls = (): FakeRequest[] => engine.requests.filter((r) => r.path !== "/version");
  return { api, calls };
}

const inspectBody = {
  Id: "abc123",
  Name: "/dpilot-shop",
  Created: "2025-01-01T00:00:00Z",
  Config: {
    Image: "mysql:8.4",
    Env: ["MYSQL_ROOT_PASSWORD=pw", "PATH=/usr/bin"],
    Labels: { "dpilot.managed": "true", "dpilot.instance": "shop" },
  },
  State: {
    Status: "running",
    Running: true,
    ExitCode: 0,
    Health: { Status: "healthy" },
  },
};

describe("DockerEngineApi", () => {
  test("imageExists maps 200 to true and 404 to false", async () => {
    const { api, calls } = await apiWith((req) =>
      req.path.includes("mysql%3A8.4") ? json(200, {}) : json(404, { message: "no such image" }),
    );

    expect(await api.imageExists("mysql:8.4")).toBe(true);
    expect(await api.imageExists("mysql:9.9")).toBe(false);
    expect(calls()[0]?.path).toBe("/images/mysql%3A8.4/json");
  });

  test("pullImage streams progress and resolves when the stream ends", async () => {
    const lines = [
      { status: "Pulling fs layer", id: "l1" },
      { status: "Downloading", id: "l1", progressDetail: { current: 5, total: 10 } },
      { status: "Pull complete", id: "l1" },
    ];
    const { api, calls } = await apiWith(() => ({
      status: 200,
      chunks: lines.map((line) => ({ data: `${JSON.stringify(line)}\n` })),
    }));
    const updates: number[] = [];

    await api.pullImage("mysql", "8.4", (p) => updates.push(p.currentBytes));

    expect(calls()[0]).toMatchObject({
      method: "POST",
      path: "/images/create?fromImage=mysql&tag=8.4",
    });
    expect(updates.at(-1)).toBe(10);
  });

  test("pullImage rejects when the stream reports an error", async () => {
    const { api } = await apiWith(() => ({
      status: 200,
      chunks: [{ data: `${JSON.stringify({ error: "manifest unknown" })}\n` }],
    }));

    await expect(api.pullImage("mysql", "0.0", () => {})).rejects.toThrow("manifest unknown");
  });

  test("non-2xx answers throw DockerApiError with the daemon message", async () => {
    const { api } = await apiWith(() => json(409, { message: "name already in use" }));

    const error = await api.createVolume("dpilot_shop_data", {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DockerApiError);
    expect((error as DockerApiError).status).toBe(409);
    expect((error as DockerApiError).message).toBe("name already in use");
  });

  test("volumeExists, createVolume and removeVolume use the volumes API", async () => {
    const { api, calls } = await apiWith((req) => {
      if (req.method === "GET") return json(404, { message: "no such volume" });
      if (req.method === "POST") return json(201, { Name: "v" });
      return { status: 204, body: "" };
    });

    expect(await api.volumeExists("dpilot_shop_data")).toBe(false);
    await api.createVolume("dpilot_shop_data", { "dpilot.managed": "true" });
    await api.removeVolume("dpilot_shop_data");

    expect(calls().map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /volumes/dpilot_shop_data",
      "POST /volumes/create",
      "DELETE /volumes/dpilot_shop_data",
    ]);
    expect(JSON.parse(calls()[1]?.body ?? "")).toEqual({
      Name: "dpilot_shop_data",
      Labels: { "dpilot.managed": "true" },
    });
  });

  test("listContainers filters by label and maps fields", async () => {
    const { api, calls } = await apiWith(() =>
      json(200, [
        {
          Id: "abc",
          Names: ["/dpilot-shop"],
          Image: "mysql:8.4",
          State: "running",
          Status: "Up 2 minutes (healthy)",
          Labels: { "dpilot.instance": "shop" },
        },
      ]),
    );

    const list = await api.listContainers("dpilot.managed=true");

    expect(list).toEqual([
      {
        id: "abc",
        image: "mysql:8.4",
        state: "running",
        status: "Up 2 minutes (healthy)",
        labels: { "dpilot.instance": "shop" },
      },
    ]);
    const path = calls()[0]?.path ?? "";
    expect(path.startsWith("/containers/json?all=true&filters=")).toBe(true);
    expect(JSON.parse(decodeURIComponent(path.split("filters=")[1] ?? ""))).toEqual({
      label: ["dpilot.managed=true"],
    });
  });

  test("createContainer posts the spec under the given name and returns the id", async () => {
    const { api, calls } = await apiWith(() => json(201, { Id: "new-id", Warnings: [] }));
    const spec: ContainerCreateSpec = {
      Image: "mysql:8.4",
      Env: ["A=1"],
      Labels: { "dpilot.managed": "true" },
      ExposedPorts: { "3306/tcp": {} },
      HostConfig: {
        PortBindings: { "3306/tcp": [{ HostIp: "127.0.0.1", HostPort: "3306" }] },
        Mounts: [{ Type: "volume", Source: "v", Target: "/var/lib/mysql" }],
        RestartPolicy: { Name: "no" },
      },
    };

    expect(await api.createContainer("dpilot-shop", spec)).toBe("new-id");
    expect(calls()[0]?.path).toBe("/containers/create?name=dpilot-shop");
    expect(JSON.parse(calls()[0]?.body ?? "")).toEqual(spec);
  });

  test("inspectContainer maps state and health, and returns null on 404", async () => {
    const { api } = await apiWith((req) =>
      req.path.startsWith("/containers/dpilot-shop/") ? json(200, inspectBody) : json(404, {}),
    );

    expect(await api.inspectContainer("dpilot-shop")).toEqual({
      id: "abc123",
      name: "dpilot-shop",
      createdAt: "2025-01-01T00:00:00Z",
      image: "mysql:8.4",
      env: { MYSQL_ROOT_PASSWORD: "pw", PATH: "/usr/bin" },
      labels: { "dpilot.managed": "true", "dpilot.instance": "shop" },
      state: { status: "running", exitCode: 0, health: "healthy" },
    });
    expect(await api.inspectContainer("dpilot-gone")).toBeNull();
  });

  test("lifecycle calls accept 204 and 304 (already in that state)", async () => {
    const { api, calls } = await apiWith((req) =>
      req.path.includes("/stop") ? { status: 304, body: "" } : { status: 204, body: "" },
    );

    await api.startContainer("c1");
    await api.stopContainer("c1");
    await api.restartContainer("c1");
    await api.removeContainer("c1");

    expect(calls().map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /containers/c1/start",
      "POST /containers/c1/stop?t=10",
      "POST /containers/c1/restart?t=10",
      "DELETE /containers/c1?force=true",
    ]);
  });

  test("containerLogs requests a tail of both streams and demuxes it", async () => {
    const payload = new TextEncoder().encode("hello\n");
    const framed = new Uint8Array(8 + payload.length);
    framed[0] = 1;
    new DataView(framed.buffer).setUint32(4, payload.length);
    framed.set(payload, 8);
    const { api, calls } = await apiWith(() => ({ status: 200, chunks: [{ data: framed }] }));

    expect(await api.containerLogs("c1", 50)).toEqual(["hello"]);
    expect(calls()[0]?.path).toBe("/containers/c1/logs?stdout=1&stderr=1&tail=50");
  });

  test("containerStats reads one sample", async () => {
    const { api, calls } = await apiWith(() =>
      json(200, {
        cpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 100, online_cpus: 1 },
        precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
        memory_stats: { usage: 10, limit: 20 },
      }),
    );

    expect(await api.containerStats("c1")).toEqual({
      cpuPercent: 0,
      memoryBytes: 10,
      memoryLimitBytes: 20,
    });
    expect(calls()[0]?.path).toBe("/containers/c1/stats?stream=false");
  });
});

describe("DockerEngineApi timeouts", () => {
  test("waits longer than the short status-probe timeout for engine calls", async () => {
    const engine = await startFakeEngine((req) =>
      req.path === "/version" ? json(200, versionBody) : { status: 200, body: "[]", delayMs: 400 },
    );
    const client = createDockerClient({
      resolveEndpoints: () => [engine.endpoint],
      timeoutMs: 150,
    });

    expect(await createDockerEngineApi(client).listContainers("x=y")).toEqual([]);
  });
});
