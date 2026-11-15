import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EngineId } from "@dpilot/shared";
import { generatePassword, isPortFree } from "../cli/runtime.ts";
import type { ConnectionConfig } from "../connections/types.ts";
import { createDockerClient } from "../docker/client.ts";
import { resolveDockerEndpoints } from "../docker/endpoint.ts";
import { createDockerEngineApi } from "../docker/engine-api.ts";
import { createInstanceService } from "../instances/service.ts";
import { bunSqlFactory } from "./bun-sql.ts";
import { createAdapter } from "./registry.ts";
import { TargetError } from "./types.ts";

const SETUP_TIMEOUT_MS = 600_000;

interface Fixture {
  engine: EngineId;
  version: string;
  name: string;
  setup: string[];
}

const MYSQL_SETUP = [
  "CREATE TABLE orders (id INT PRIMARY KEY)",
  "CREATE VIEW order_ids AS SELECT id FROM orders",
  "CREATE PROCEDURE touch_orders() BEGIN SELECT 1; END",
  "CREATE FUNCTION one() RETURNS INT DETERMINISTIC RETURN 1",
  "CREATE USER 'it_reader'@'%' IDENTIFIED BY 'reader-pw'",
  "GRANT SELECT ON app.* TO 'it_reader'@'%'",
];

const FIXTURES: Fixture[] = [
  { engine: "mysql", version: "8.4", name: "it-mysql", setup: MYSQL_SETUP },
  { engine: "mariadb", version: "11.8", name: "it-mariadb", setup: MYSQL_SETUP },
  {
    engine: "postgres",
    version: "17",
    name: "it-postgres",
    setup: [
      "CREATE TABLE orders (id INT PRIMARY KEY)",
      "CREATE VIEW order_ids AS SELECT id FROM orders",
      "CREATE PROCEDURE touch_orders() LANGUAGE sql AS 'SELECT 1'",
      "CREATE FUNCTION one() RETURNS int LANGUAGE sql AS 'SELECT 1'",
      "CREATE USER it_reader PASSWORD 'reader-pw'",
    ],
  },
];

const docker = createDockerClient({
  resolveEndpoints: () =>
    resolveDockerEndpoints({
      env: process.env,
      platform: process.platform,
      homeDir: process.env.HOME ?? process.env.USERPROFILE ?? "",
    }),
  timeoutMs: 10_000,
});
const instances = createInstanceService({
  docker: createDockerEngineApi(docker),
  isPortFree,
  generatePassword,
});

const configs = new Map<string, ConnectionConfig>();

async function configFor(fixture: Fixture): Promise<ConnectionConfig> {
  const detail = await instances.get(fixture.name);
  if (detail.connection === null) throw new Error(`${fixture.name} has no connection`);
  return {
    engine: fixture.engine,
    host: detail.connection.host,
    port: detail.connection.port,
    username: detail.connection.user,
    password: detail.connection.password,
    database: null,
    tls: { mode: "off", ca: null },
    readOnly: false,
  };
}

function adapterFor(config: ConnectionConfig) {
  return createAdapter(config, bunSqlFactory, { managed: true, readOnly: false });
}

async function failure(run: () => Promise<unknown>): Promise<TargetError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof TargetError) return error;
    throw error;
  }
  throw new Error("expected a TargetError");
}

async function waitReady(name: string): Promise<void> {
  await instances.settled(name);
  const deadline = Date.now() + SETUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { state } = await instances.get(name);
    if (state.status === "ready") return;
    if (["failed", "unhealthy", "stopped", "dead"].includes(state.status)) {
      throw new Error(`${name} did not start: ${JSON.stringify(state)}`);
    }
    await Bun.sleep(1000);
  }
  throw new Error(`${name} was not ready in time`);
}

async function closedPort(): Promise<number> {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const { port } = listener;
  listener.stop(true);
  return port;
}

describe.skipIf(process.env.DPILOT_INTEGRATION !== "1")("explorer adapters", () => {
  beforeAll(async () => {
    await Promise.all(
      FIXTURES.map(async (fixture) => {
        await instances.create({
          engine: fixture.engine,
          version: fixture.version,
          name: fixture.name,
          database: "app",
        });
        await waitReady(fixture.name);
        const config = await configFor(fixture);
        configs.set(fixture.name, config);
        const client = bunSqlFactory(config, "app");
        try {
          for (const statement of fixture.setup) await client.query(statement);
        } finally {
          await client.close();
        }
      }),
    );
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.allSettled(
      FIXTURES.map((fixture) => instances.remove(fixture.name, { removeVolume: true })),
    );
  }, SETUP_TIMEOUT_MS);

  for (const fixture of FIXTURES) {
    const config = () => {
      const found = configs.get(fixture.name);
      if (!found) throw new Error(`${fixture.name} was not set up`);
      return found;
    };
    const schema = fixture.engine === "postgres" ? "public" : null;

    test(`${fixture.engine} separates app from the system databases`, async () => {
      const adapter = adapterFor(config());
      try {
        const databases = await adapter.databases();
        expect(databases.find((d) => d.name === "app")).toMatchObject({ system: false });
        const system = databases.filter((d) => d.system).map((d) => d.name);
        expect(system).toContain(fixture.engine === "postgres" ? "postgres" : "mysql");
      } finally {
        await adapter.close();
      }
    });

    test(`${fixture.engine} lists the table, view, procedure and function`, async () => {
      const adapter = adapterFor(config());
      try {
        expect(await adapter.objects("app", schema)).toEqual({
          tables: ["orders"],
          views: ["order_ids"],
          procedures: ["touch_orders"],
          functions: ["one"],
        });
      } finally {
        await adapter.close();
      }
    });

    test(`${fixture.engine} reports info`, async () => {
      const adapter = adapterFor(config());
      try {
        const info = await adapter.info();
        expect(info.engine).toBe(fixture.engine);
        expect(info.version.length).toBeGreaterThan(0);
        expect(info.uptimeSeconds).toBeGreaterThan(0);
      } finally {
        await adapter.close();
      }
    });

    test(`${fixture.engine} reports variables`, async () => {
      const adapter = adapterFor(config());
      try {
        expect((await adapter.variables()).length).toBeGreaterThan(100);
      } finally {
        await adapter.close();
      }
    });

    test(`${fixture.engine} lets a fresh user with no default database list them`, async () => {
      const adapter = adapterFor({ ...config(), username: "it_reader", password: "reader-pw" });
      try {
        const names = (await adapter.databases()).map((d) => d.name);
        expect(names).toContain("app");
      } finally {
        await adapter.close();
      }
    });

    test(`${fixture.engine} classifies a wrong password as auth_failed`, async () => {
      const adapter = adapterFor({ ...config(), password: "wrong-password" });
      try {
        expect((await failure(() => adapter.info())).code).toBe("auth_failed");
      } finally {
        await adapter.close();
      }
    });
  }

  test("classifies a closed port as unreachable", async () => {
    const base = configs.get("it-postgres");
    if (!base) throw new Error("it-postgres was not set up");
    const adapter = adapterFor({ ...base, port: await closedPort() });
    try {
      expect((await failure(() => adapter.info())).code).toBe("unreachable");
    } finally {
      await adapter.close();
    }
  });

  test("fails a require-TLS connection to a server without TLS as tls_failed", async () => {
    const base = configs.get("it-postgres");
    if (!base) throw new Error("it-postgres was not set up");
    const adapter = adapterFor({ ...base, tls: { mode: "require", ca: null } });
    try {
      expect((await failure(() => adapter.info())).code).toBe("tls_failed");
    } finally {
      await adapter.close();
    }
  });
});
