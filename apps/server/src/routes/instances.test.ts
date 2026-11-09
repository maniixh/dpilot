import { describe, expect, test } from "bun:test";
import { ENGINES } from "@dpilot/shared";
import { DockerApiError } from "../docker/engine-api.ts";
import { DockerTimeoutError, DockerUnavailableError } from "../docker/types.ts";
import { buildContainerSpec } from "../instances/engine-specs.ts";
import { authedHeaders, buildTestApp } from "../testing/build-app.ts";

const jsonHeaders = {
  ...authedHeaders,
  origin: `http://${authedHeaders.host}`,
  "content-type": "application/json",
};

function setup() {
  const ctx = buildTestApp();
  const call = (method: string, path: string, body?: unknown) =>
    ctx.app.request(`/api${path}`, {
      method,
      headers: method === "GET" ? authedHeaders : jsonHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const addInstance = (name: string, port = 3306) =>
    ctx.engine.addContainer({
      name: `dpilot-${name}`,
      spec: buildContainerSpec({ name, engine: "mysql", version: "8.4", port, password: "pw" }),
      state: "running",
      health: "healthy",
      exitCode: 0,
    });
  return { ...ctx, call, addInstance };
}

describe("catalog routes", () => {
  test("GET /catalog/engines lists the supported engines", async () => {
    const res = await setup().call("GET", "/catalog/engines");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(ENGINES)));
  });

  test("GET /catalog/engines/:engine/versions returns the version source result", async () => {
    const { call } = setup();

    const res = await call("GET", "/catalog/engines/postgres/versions");

    expect(await res.json()).toEqual({
      engine: "postgres",
      versions: ["2.0", "1.0"],
      source: "fallback",
    });
    expect((await call("GET", "/catalog/engines/oracle/versions")).status).toBe(404);
  });
});

describe("instance routes", () => {
  test("POST /instances validates the body", async () => {
    const { call } = setup();

    const res = await call("POST", "/instances", {
      engine: "mysql",
      version: "8.4",
      name: "Bad Name",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  test("POST /instances accepts the request and provisions in the background", async () => {
    const { call, deps } = setup();

    const res = await call("POST", "/instances", { engine: "mysql", version: "8.4", name: "shop" });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ name: "shop", port: 3306 });
    await deps.instances.settled("shop");
    const list = await (await call("GET", "/instances")).json();
    expect(list).toEqual([
      { name: "shop", engine: "mysql", version: "8.4", port: 3306, state: { status: "starting" } },
    ]);
  });

  test("POST /instances answers 409 with a message for a taken name", async () => {
    const { call, addInstance } = setup();
    addInstance("shop");

    const res = await call("POST", "/instances", { engine: "mysql", version: "8.4", name: "shop" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "conflict",
      message: 'An instance named "shop" already exists',
    });
  });

  test("GET /instances/:name returns details and 404 for unknown names", async () => {
    const { call, addInstance } = setup();
    addInstance("shop");

    const res = await call("GET", "/instances/shop");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "shop", connection: { password: "pw" } });

    const missing = await call("GET", "/instances/nope");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "not_found" });
  });

  test("lifecycle actions answer 204", async () => {
    const { call, addInstance, engine } = setup();
    const c = addInstance("shop");

    for (const action of ["stop", "start", "restart"]) {
      expect((await call("POST", `/instances/shop/${action}`)).status).toBe(204);
    }
    expect(engine.calls).toEqual([
      `stopContainer ${c.id}`,
      `startContainer ${c.id}`,
      `restartContainer ${c.id}`,
    ]);
    expect((await call("POST", "/instances/shop/explode")).status).toBe(404);
  });

  test("DELETE /instances/:name keeps the volume unless removeVolume=true", async () => {
    const { call, addInstance, engine } = setup();
    addInstance("keep");
    addInstance("drop", 3307);
    engine.volumes.set("dpilot_keep_data", {});
    engine.volumes.set("dpilot_drop_data", {});

    expect((await call("DELETE", "/instances/keep")).status).toBe(204);
    expect((await call("DELETE", "/instances/drop?removeVolume=true")).status).toBe(204);
    expect([...engine.volumes.keys()]).toEqual(["dpilot_keep_data"]);
    expect((await call("DELETE", "/instances/x?removeVolume=maybe")).status).toBe(400);
  });

  test("GET logs, stats and compose", async () => {
    const { call, addInstance, engine } = setup();
    addInstance("shop");
    engine.logLines = ["one", "two", "three"];

    expect(await (await call("GET", "/instances/shop/logs?tail=2")).json()).toEqual({
      lines: ["two", "three"],
    });
    expect((await call("GET", "/instances/shop/logs?tail=0")).status).toBe(400);
    expect(await (await call("GET", "/instances/shop/stats")).json()).toEqual(engine.statsSample);
    expect(await (await call("GET", "/instances/shop/compose")).json()).toMatchObject({
      fileName: "dpilot-shop.compose.yml",
    });
  });

  test("a Docker outage answers 503 docker_unavailable", async () => {
    const { call, engine } = setup();
    engine.listContainers = async () => {
      throw new DockerUnavailableError("pipe not found");
    };

    const res = await call("GET", "/instances");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "docker_unavailable", message: "pipe not found" });
  });

  test("a Docker timeout answers 504 docker_timeout", async () => {
    const { call, addInstance, engine } = setup();
    addInstance("shop");
    engine.stopContainer = async () => {
      throw new DockerTimeoutError("Docker did not respond within 30000ms");
    };

    const res = await call("POST", "/instances/shop/stop");

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({
      error: "docker_timeout",
      message: "Docker did not respond within 30000ms",
    });
  });

  test("a Docker API failure answers 502 with the daemon's message", async () => {
    const { call, addInstance, engine } = setup();
    addInstance("shop");
    engine.stopContainer = async () => {
      throw new DockerApiError(500, "cannot stop container");
    };

    const res = await call("POST", "/instances/shop/stop");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "docker_error", message: "cannot stop container" });
  });
});
