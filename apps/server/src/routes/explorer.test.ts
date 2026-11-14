import { expect, test } from "bun:test";
import { buildContainerSpec } from "../instances/engine-specs.ts";
import { authedHeaders, buildTestApp } from "../testing/build-app.ts";
import { driverError } from "../testing/fake-sql.ts";

function setup() {
  const ctx = buildTestApp();
  const get = (path: string) => ctx.app.request(`/api${path}`, { headers: authedHeaders });
  const addServer = (name: string, state = "running") =>
    ctx.engine.addContainer({
      name: `dpilot-${name}`,
      spec: buildContainerSpec({
        name,
        engine: "postgres",
        version: "17",
        port: 5432,
        password: "pw",
        database: null,
      }),
      state,
      health: "healthy",
      exitCode: 0,
    });
  return { ...ctx, get, addServer };
}

test("lists targets", async () => {
  const { get, addServer } = setup();
  addServer("orders");
  const res = await get("/targets");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    servers: {
      status: "ok",
      targets: [
        { id: "s.orders", kind: "server", label: "orders", engine: "postgres", available: true },
      ],
    },
    connections: [],
  });
});

test("returns 404 for an unknown target id", async () => {
  const { get } = setup();
  const malformed = await get("/c/x.bad/info");
  expect(malformed.status).toBe(404);
  expect(await malformed.json()).toMatchObject({ error: "target_not_found" });
  expect((await get("/c/s.missing/info")).status).toBe(404);
});

test("returns 409 for a stopped server", async () => {
  const { get, addServer } = setup();
  addServer("orders", "exited");
  const res = await get("/c/s.orders/databases");
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: "target_unavailable",
    message: "The server orders is stopped. Start it to browse it.",
  });
});

test("maps unreachable to 502 and timeouts to 504", async () => {
  const { get, addServer, sql } = setup();
  addServer("orders");
  sql.respond(/pg_database/, driverError({ code: "ECONNREFUSED" }));
  expect((await get("/c/s.orders/databases")).status).toBe(502);
  sql.respond(/pg_database/, driverError({ code: "ETIMEDOUT" }));
  expect((await get("/c/s.orders/databases")).status).toBe(504);
});

test("serves info, variables, schemas and objects", async () => {
  const { get, addServer, sql } = setup();
  addServer("orders");
  sql.respond(/pg_settings/, [{ name: "port", setting: "5432", unit: null, description: null }]);
  sql.respond(/^SELECT nspname AS name FROM pg_namespace/, [{ name: "public" }]);
  expect(await (await get("/c/s.orders/variables")).json()).toEqual([
    { name: "port", value: "5432", description: null },
  ]);
  expect(await (await get("/c/s.orders/db/app/schemas")).json()).toEqual([{ name: "public" }]);
  const objects = await get("/c/s.orders/db/app/objects?schema=sales");
  expect(await objects.json()).toEqual({ tables: [], views: [], procedures: [], functions: [] });
  expect(sql.calls.at(-1)?.params).toEqual(["sales"]);
});

test("lists databases for a saved connection", async () => {
  const { app, get, sql } = setup();
  const created = await app.request("/api/connections", {
    method: "POST",
    headers: {
      ...authedHeaders,
      origin: `http://${authedHeaders.host}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      label: "Prod",
      engine: "mysql",
      host: "db.example.com",
      port: 3306,
      username: "app",
      tls: { mode: "off", ca: null },
    }),
  });
  const { id } = (await created.json()) as { id: string };
  sql.respond(/SHOW DATABASES/, [{ Database: "shop" }]);
  const res = await get(`/c/c.${id}/databases`);
  expect(await res.json()).toEqual([{ name: "shop", system: false, browsable: true }]);
});

test("passes encoded database names through unchanged", async () => {
  const { get, addServer, sql } = setup();
  addServer("orders");
  const res = await get(`/c/s.orders/db/${encodeURIComponent('we"ird db.x')}/schemas`);
  expect(res.status).toBe(200);
  expect(sql.calls.at(-1)?.database).toBe('we"ird db.x');
});

test("rejects an over-long schema", async () => {
  const { get, addServer } = setup();
  addServer("orders");
  const res = await get(`/c/s.orders/db/app/objects?schema=${"s".repeat(129)}`);
  expect(res.status).toBe(400);
});
