import { beforeEach, expect, test } from "bun:test";
import type { EngineId } from "@dpilot/shared";
import { createConnectionService } from "../connections/service.ts";
import type { ConnectionService } from "../connections/types.ts";
import { DockerUnavailableError } from "../docker/types.ts";
import { buildContainerSpec } from "../instances/engine-specs.ts";
import { createInstanceService, type InstanceService } from "../instances/service.ts";
import { openStore } from "../store/database.ts";
import type { KeyStore } from "../store/types.ts";
import { FakeEngineApi } from "../testing/fake-engine-api.ts";
import { driverError, FakeSqlFactory } from "../testing/fake-sql.ts";
import { createExplorer } from "./service.ts";
import type { Explorer } from "./types.ts";

let docker: FakeEngineApi;
let instances: InstanceService;
let connections: ConnectionService;
let sql: FakeSqlFactory;
let explorer: Explorer;

function memoryKeys(): KeyStore {
  let key: Uint8Array | null = null;
  return {
    read: () => key,
    create: () => {
      key = crypto.getRandomValues(new Uint8Array(32));
      return key;
    },
  };
}

function addServer(
  name: string,
  options: { engine?: EngineId; state?: string; password?: string } = {},
) {
  docker.addContainer({
    name: `dpilot-${name}`,
    spec: buildContainerSpec({
      name,
      engine: options.engine ?? "postgres",
      version: "17",
      port: 5432,
      password: options.password ?? "pw",
      database: null,
    }),
    state: options.state ?? "running",
    health: "healthy",
    exitCode: 0,
  });
}

beforeEach(() => {
  docker = new FakeEngineApi();
  instances = createInstanceService({
    docker,
    isPortFree: async () => true,
    generatePassword: () => "generated-pw",
  });
  let n = 0;
  connections = createConnectionService({
    db: openStore(":memory:"),
    keys: memoryKeys(),
    now: () => new Date("2026-11-15T00:00:00Z"),
    randomId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    onChanged: () => {},
  });
  sql = new FakeSqlFactory();
  explorer = createExplorer({ instances, connections, sql: sql.factory });
});

const input = {
  label: "Prod",
  engine: "mysql" as const,
  host: "db.example.com",
  port: 3306,
  username: "app",
  password: "s3cret",
  tls: { mode: "off" as const, ca: null },
};

test("lists Dpilot servers first, then saved connections", async () => {
  addServer("orders");
  const saved = await connections.create(input);
  expect(await explorer.targets()).toEqual({
    servers: {
      status: "ok",
      targets: [
        { id: "s.orders", kind: "server", label: "orders", engine: "postgres", available: true },
      ],
    },
    connections: [
      { id: `c.${saved.id}`, kind: "connection", label: "Prod", engine: "mysql", available: true },
    ],
  });
});

test("explains why a stopped server can't be browsed", async () => {
  addServer("orders", { state: "exited" });
  const { servers } = await explorer.targets();
  expect(servers).toMatchObject({
    targets: [{ available: false, reason: "Stopped. Start it to browse it." }],
  });
  await expect(explorer.run("s.orders", (a) => a.databases())).rejects.toMatchObject({
    code: "target_unavailable",
    message: "The server orders is stopped. Start it to browse it.",
  });
});

test("lists saved connections when Docker is unavailable", async () => {
  await connections.create(input);
  const down: InstanceService = {
    ...instances,
    list: async () => {
      throw new DockerUnavailableError("Docker isn't running");
    },
  };
  const result = await createExplorer({ instances: down, connections, sql: sql.factory }).targets();
  expect(result.servers).toEqual({
    status: "unavailable",
    message: "Docker isn't reachable, so Dpilot's servers can't be listed.",
  });
  expect(result.connections).toHaveLength(1);
});

test("flags a connection whose password was lost", async () => {
  const saved = await connections.create(input);
  const lost: ConnectionService = {
    ...connections,
    list: async () => [{ ...saved, passwordLost: true }],
  };
  const result = await createExplorer({ instances, connections: lost, sql: sql.factory }).targets();
  expect(result.connections[0]).toMatchObject({
    available: false,
    reason: "Enter the password again to browse it.",
  });
});

test("reuses one adapter per target", async () => {
  addServer("orders");
  await explorer.run("s.orders", (a) => a.databases());
  await explorer.run("s.orders", (a) => a.databases());
  expect(sql.created).toHaveLength(1);
  expect(sql.configs[0]).toMatchObject({ password: "pw", tls: { mode: "off", ca: null } });
});

test("replaces the cached adapter when credentials change", async () => {
  addServer("orders");
  await explorer.run("s.orders", (a) => a.databases());
  docker.containers.delete("dpilot-orders");
  addServer("orders", { password: "pw2" });
  await explorer.run("s.orders", (a) => a.databases());
  expect(sql.created).toHaveLength(2);
  expect(sql.closed).toHaveLength(1);
  expect(sql.configs[1]?.password).toBe("pw2");
});

test("evicts the adapter after a connection failure", async () => {
  addServer("orders");
  sql.respond(/pg_database/, driverError({ code: "ECONNREFUSED" }));
  await expect(explorer.run("s.orders", (a) => a.databases())).rejects.toMatchObject({
    code: "unreachable",
  });
  expect(sql.closed).toHaveLength(1);
  await explorer.run("s.orders", (a) => a.schemas("app")).catch(() => {});
  expect(sql.created).toHaveLength(2);
});

test("keeps the adapter after a query failure", async () => {
  addServer("orders");
  sql.respond(/pg_database/, new Error("boom"));
  await expect(explorer.run("s.orders", (a) => a.databases())).rejects.toMatchObject({
    code: "query_failed",
  });
  expect(sql.closed).toHaveLength(0);
});

test("returns not found for an unknown target", async () => {
  await expect(explorer.run("s.nope", (a) => a.info())).rejects.toMatchObject({
    code: "target_not_found",
  });
  await expect(explorer.run("x.bad", (a) => a.info())).rejects.toMatchObject({
    code: "target_not_found",
  });
  const unknown = "c.00000000-0000-4000-8000-999999999999";
  await expect(explorer.run(unknown, (a) => a.info())).rejects.toMatchObject({
    code: "target_not_found",
  });
});

test("runs against a saved connection", async () => {
  const saved = await connections.create(input);
  await explorer.run(`c.${saved.id}`, (a) => a.databases());
  expect(sql.configs[0]).toMatchObject({ host: "db.example.com", password: "s3cret" });
});

test("forget closes the cached adapter", async () => {
  addServer("orders");
  await explorer.run("s.orders", (a) => a.databases());
  await explorer.forget("s.orders");
  expect(sql.closed).toHaveLength(1);
});

test("test reports a failure as a result", async () => {
  sql.respond(/VERSION/, driverError({ errno: 1045 }));
  expect(await explorer.test(input)).toEqual({
    ok: false,
    code: "auth_failed",
    message: "The server rejected user app. Check the user and password.",
  });
});

test("test closes its adapter", async () => {
  sql.respond(/VERSION/, [{ version: "8.4.3", user: "app@%", charset: null, timeZone: null }]);
  const result = await explorer.test(input);
  expect(result).toMatchObject({ ok: true, info: { version: "8.4.3" } });
  expect(sql.closed).toHaveLength(1);
});
