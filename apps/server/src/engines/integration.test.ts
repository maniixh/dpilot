import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EngineId, QueryRequest } from "@dpilot/shared";
import { generatePassword, isPortFree } from "../cli/runtime.ts";
import type { ConnectionConfig } from "../connections/types.ts";
import { createDockerClient } from "../docker/client.ts";
import { resolveDockerEndpoints } from "../docker/endpoint.ts";
import { createDockerEngineApi } from "../docker/engine-api.ts";
import { createInstanceService } from "../instances/service.ts";
import { bunSessionFactory } from "../query/bun-session.ts";
import { createQueryService } from "../query/service.ts";
import type { QueryService } from "../query/types.ts";
import { openStore } from "../store/database.ts";
import { createHistoryStore } from "../store/history.ts";
import { bunSqlFactory } from "./bun-sql.ts";
import { createAdapter, createDataAdapter } from "./registry.ts";
import { type DataAdapter, TargetError } from "./types.ts";

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

/** The grid tables live in their own database so the explorer checks keep an exact object list. */
const DATA_DB = "data_it";

const MYSQL_DATA_SETUP = [
  `CREATE TABLE grid (id BIGINT PRIMARY KEY, at DATETIME(6), note TEXT, img BLOB)`,
  `INSERT INTO grid VALUES
    (9007199254740992, '2024-01-02 03:04:05.123456', 'big', X'0102'),
    (9007199254740993, '2024-01-02 03:04:05.654321', 'bigger', NULL),
    (1, NULL, 'one', NULL),
    (2, NULL, NULL, NULL)`,
  "CREATE TABLE capped (id INT PRIMARY KEY, label VARCHAR(5))",
];

const POSTGRES_DATA_SETUP = [
  `CREATE TABLE grid (id BIGINT PRIMARY KEY, at TIMESTAMP(6), tags INT[], note TEXT, img BYTEA)`,
  `INSERT INTO grid VALUES
    (9007199254740992, '2024-01-02 03:04:05.123456', '{1,2}', 'big', '\\x0102'),
    (9007199254740993, '2024-01-02 03:04:05.654321', '{}', 'bigger', NULL),
    (1, NULL, NULL, 'one', NULL),
    (2, NULL, NULL, NULL, NULL)`,
  "CREATE TABLE capped (id INT PRIMARY KEY, label VARCHAR(5))",
  "CREATE TABLE covering (id INT, note TEXT, PRIMARY KEY (id) INCLUDE (note))",
  "INSERT INTO covering VALUES (1, NULL)",
];

function dataSetup(engine: EngineId): string[] {
  return engine === "postgres" ? POSTGRES_DATA_SETUP : MYSQL_DATA_SETUP;
}

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
          await client.query(`CREATE DATABASE ${DATA_DB}`);
        } finally {
          await client.close();
        }
        const dataClient = bunSqlFactory(config, DATA_DB);
        try {
          for (const statement of dataSetup(fixture.engine)) await dataClient.query(statement);
        } finally {
          await dataClient.close();
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

    describe(`${fixture.engine} data`, () => {
      const ref = { schema, table: "grid" };
      const noFilter = { filters: [], search: null };
      const BIG = "9007199254740992";
      const BIGGER = "9007199254740993";

      const withData = async <T>(use: (adapter: DataAdapter) => Promise<T>): Promise<T> => {
        const adapter = createDataAdapter(config(), bunSqlFactory, {
          managed: true,
          readOnly: false,
        });
        try {
          return await use(adapter);
        } finally {
          await adapter.close();
        }
      };

      /** Every row as column → cell, ordered by id. */
      const readGrid = (adapter: DataAdapter) =>
        adapter.rows(DATA_DB, { ref, ...noFilter, sort: [], offset: 0, limit: 100 });
      const column = async (adapter: DataAdapter, name: string) => {
        const meta = await adapter.table(DATA_DB, ref);
        return meta.columns.findIndex((c) => c.name === name);
      };
      const noteOf = async (adapter: DataAdapter, id: string) => {
        const page = await readGrid(adapter);
        const index = await column(adapter, "note");
        const at = (page.keys ?? []).findIndex((key) => key.id === id);
        return page.rows[at]?.[index];
      };

      const withQuery = async <T>(use: (query: QueryService) => Promise<T>): Promise<T> => {
        const query = createQueryService({
          resolve: async () => ({ config: config(), ctx: { managed: true, readOnly: false } }),
          sessions: bunSessionFactory,
          history: createHistoryStore(openStore(":memory:")),
          now: Date.now,
        });
        try {
          return await use(query);
        } finally {
          await query.closeAll();
        }
      };
      const TAB = crypto.randomUUID();
      const runRequest = (sql: string): QueryRequest => ({
        runId: crypto.randomUUID(),
        sql,
        database: null,
        tab: TAB,
        maxRows: 1000,
        confirmed: false,
      });

      test("cancel stops a long statement within 2 s and the tab still runs", async () => {
        await withQuery(async (query) => {
          const sleep = runRequest(
            fixture.engine === "postgres" ? "SELECT pg_sleep(5)" : "SELECT SLEEP(5)",
          );
          const started = Date.now();
          const pending = query.run("s.it", sleep);
          await Bun.sleep(500);
          await query.cancel("s.it", sleep.runId);
          const cancelled = await pending;
          expect(Date.now() - started).toBeLessThan(2000);
          expect(cancelled.stopped).not.toBeNull();
          const next = await query.run("s.it", runRequest("SELECT 1"));
          expect(next).toMatchObject({ stopped: null, summary: { succeeded: 1 } });
        });
      });

      test("USE and SET persist across runs on one tab", async () => {
        await withQuery(async (query) => {
          const [setup, probe] =
            fixture.engine === "postgres"
              ? ["SET application_name = 'dpilot_it'", "SHOW application_name"]
              : [`USE ${DATA_DB}; SET @v = 7`, "SELECT DATABASE(), @v"];
          await query.run("s.it", runRequest(setup));
          const result = await query.run("s.it", runRequest(probe));
          const outcome = result.outcomes[0];
          if (outcome?.kind !== "rows") throw new Error("expected rows");
          expect(outcome.rows[0]?.map(String)).toEqual(
            fixture.engine === "postgres" ? ["dpilot_it"] : [DATA_DB, "7"],
          );
        });
      });

      test("pages, sorts and filters rows", async () => {
        await withData(async (adapter) => {
          const sorted = await adapter.rows(DATA_DB, {
            ref,
            ...noFilter,
            sort: [{ column: "id", direction: "asc" }],
            offset: 1,
            limit: 2,
          });
          expect(sorted.keys).toEqual([{ id: "2" }, { id: BIG }]);
          const filtered = await adapter.rows(DATA_DB, {
            ref,
            filters: [{ op: "like", column: "note", value: "big%" }],
            search: null,
            sort: [{ column: "id", direction: "desc" }],
            offset: 0,
            limit: 10,
          });
          expect(filtered.keys).toEqual([{ id: BIGGER }, { id: BIG }]);
        });
      });

      test("updates only the row with a key above 2^53", async () => {
        await withData(async (adapter) => {
          await adapter.update(DATA_DB, {
            ref,
            key: { id: BIGGER },
            values: { note: { set: "changed" } },
          });
          expect(await noteOf(adapter, BIGGER)).toBe("changed");
          expect(await noteOf(adapter, BIG)).toBe("big");
        });
      });

      test("round-trips microseconds and arrays through update", async () => {
        await withData(async (adapter) => {
          const names = fixture.engine === "postgres" ? ["at", "tags"] : ["at"];
          const read = async () => {
            const page = await readGrid(adapter);
            const spot = (page.keys ?? []).findIndex((key) => key.id === BIG);
            return Promise.all(
              names.map(async (name) => page.rows[spot]?.[await column(adapter, name)]),
            );
          };
          const before = await read();
          expect(before[0]).toBe("2024-01-02 03:04:05.123456");
          if (fixture.engine === "postgres") expect(before[1]).toBe("{1,2}");
          await adapter.update(DATA_DB, {
            ref,
            key: { id: BIG },
            values: Object.fromEntries(
              names.map((name, index) => [name, { set: before[index] as string }]),
            ),
          });
          expect(await read()).toEqual(before);
        });
      });

      test("uploads and downloads a blob", async () => {
        await withData(async (adapter) => {
          const bytes = new Uint8Array([0, 1, 2, 255]);
          await adapter.writeCell(DATA_DB, ref, { id: "1" }, "img", bytes);
          const back = await adapter.readCell(DATA_DB, ref, { id: "1" }, "img");
          expect(Array.from(back)).toEqual(Array.from(bytes));
        });
      });

      test("counts and sums", async () => {
        await withData(async (adapter) => {
          const small = { ref, filters: [{ op: "lt" as const, column: "id", value: "10" }] };
          expect(await adapter.count(DATA_DB, { ...small, search: null })).toBe(2);
          const { values } = await adapter.aggregate(DATA_DB, {
            ...small,
            search: null,
            aggregates: [{ fn: "sum", column: "id" }],
          });
          expect(Number(values[0])).toBe(3);
        });
      });

      test("deletes by key", async () => {
        await withData(async (adapter) => {
          await adapter.remove(DATA_DB, { ref, keys: [{ id: "2" }] });
          expect(await adapter.count(DATA_DB, { ref, ...noFilter })).toBe(3);
        });
      });

      test("refuses an over-length varchar instead of truncating", async () => {
        await withData(async (adapter) => {
          const capped = { schema, table: "capped" };
          await expect(
            adapter.insert(DATA_DB, {
              ref: capped,
              values: { id: { set: "1" }, label: { set: "far too long" } },
            }),
          ).rejects.toBeInstanceOf(TargetError);
          expect(await adapter.count(DATA_DB, { ref: capped, ...noFilter })).toBe(0);
        });
      });

      if (fixture.engine === "postgres") {
        test("edits a table whose primary key INCLUDEs a nullable column", async () => {
          await withData(async (adapter) => {
            const covering = { schema, table: "covering" };
            const meta = await adapter.table(DATA_DB, covering);
            expect(meta).toMatchObject({ primaryKey: ["id"], editable: true });
            await adapter.update(DATA_DB, {
              ref: covering,
              key: { id: "1" },
              values: { note: { set: "filled" } },
            });
            const page = await adapter.rows(DATA_DB, {
              ref: covering,
              ...noFilter,
              sort: [],
              offset: 0,
              limit: 10,
            });
            expect(page.rows).toEqual([[1, "filled"]]);
          });
        });
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
