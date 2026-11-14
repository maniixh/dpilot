import { beforeEach, expect, test } from "bun:test";
import type { ConnectionConfig } from "../connections/types.ts";
import { driverError, FakeSqlFactory } from "../testing/fake-sql.ts";
import { createPostgresAdapter } from "./postgres.ts";

const config: ConnectionConfig = {
  engine: "postgres",
  host: "127.0.0.1",
  port: 5432,
  username: "postgres",
  password: "x",
  database: null,
  tls: { mode: "off", ca: null },
};
const ctx = { managed: false };
let sql: FakeSqlFactory;
beforeEach(() => {
  sql = new FakeSqlFactory();
});

const pgDatabases = [
  { name: "app", browsable: true },
  { name: "postgres", browsable: true },
  { name: "template0", browsable: false },
  { name: "template1", browsable: true },
];

test("treats postgres as system only when it isn't the default", async () => {
  sql.respond(/pg_database/, pgDatabases);
  const plain = await createPostgresAdapter(config, sql.factory, ctx).databases();
  expect(plain.filter((d) => !d.system).map((d) => d.name)).toEqual(["app"]);
  const hosted = createPostgresAdapter({ ...config, database: "postgres" }, sql.factory, ctx);
  expect((await hosted.databases()).filter((d) => !d.system).map((d) => d.name)).toEqual([
    "app",
    "postgres",
  ]);
});

test("marks databases that refuse connections as not browsable", async () => {
  sql.respond(/pg_database/, pgDatabases);
  const dbs = await createPostgresAdapter(config, sql.factory, ctx).databases();
  expect(dbs.find((d) => d.name === "template0")).toEqual({
    name: "template0",
    system: true,
    browsable: false,
  });
});

test("falls back to the default database when listing is denied", async () => {
  sql.respond(/pg_database/, driverError({ errno: "42501" }));
  const adapter = createPostgresAdapter({ ...config, database: "app" }, sql.factory, ctx);
  expect(await adapter.databases()).toEqual([{ name: "app", system: false, browsable: true }]);
});

test("excludes system schemas in the query", async () => {
  sql.respond(/pg_namespace/, [{ name: "public" }, { name: "sales" }]);
  const schemas = await createPostgresAdapter(config, sql.factory, ctx).schemas("app");
  expect(schemas).toEqual([{ name: "public" }, { name: "sales" }]);
  const text = sql.calls.at(-1)?.text ?? "";
  expect(text).toContain("pg_toast");
  expect(text).toContain("pg_temp");
  expect(sql.calls.at(-1)?.database).toBe("app");
});

test("groups tables, views and routines in a schema", async () => {
  sql.respond(/pg_class/, [
    { name: "orders", kind: "r" },
    { name: "parts", kind: "p" },
    { name: "totals", kind: "v" },
    { name: "cache", kind: "m" },
  ]);
  sql.respond(/pg_proc/, [
    { name: "tax", kind: "f" },
    { name: "refresh", kind: "p" },
  ]);
  const groups = await createPostgresAdapter(config, sql.factory, ctx).objects("app", "sales");
  expect(groups).toEqual({
    tables: ["orders", "parts"],
    views: ["totals", "cache"],
    procedures: ["refresh"],
    functions: ["tax"],
  });
  for (const call of sql.calls) expect(call.params).toEqual(["sales"]);
});

test("defaults to the public schema", async () => {
  await createPostgresAdapter(config, sql.factory, ctx).objects("app", null);
  expect(sql.calls[0]?.params).toEqual(["public"]);
});

test("opens one client per database and closes them all", async () => {
  const adapter = createPostgresAdapter(config, sql.factory, ctx);
  await adapter.databases();
  await adapter.schemas("app");
  await adapter.schemas("app");
  await adapter.schemas("shop");
  await adapter.close();
  expect(sql.created).toEqual(["postgres", "app", "shop"]);
  expect([...sql.closed].sort()).toEqual(["app", "postgres", "shop"]);
});

test("formats variables with units", async () => {
  sql.respond(/pg_settings/, [
    { name: "shared_buffers", setting: "128", unit: "MB", description: "Memory." },
    { name: "port", setting: "5432", unit: null, description: "Port." },
  ]);
  expect(await createPostgresAdapter(config, sql.factory, ctx).variables()).toEqual([
    { name: "shared_buffers", value: "128 MB", description: "Memory." },
    { name: "port", value: "5432", description: "Port." },
  ]);
});

test("coerces uptime to a number", async () => {
  sql.respond(/server_version/, [
    {
      version: "17.2",
      user: "postgres",
      uptime: "3600",
      charset: "UTF8",
      timeZone: "Etc/UTC",
    },
  ]);
  expect(await createPostgresAdapter(config, sql.factory, ctx).info()).toEqual({
    engine: "postgres",
    version: "17.2",
    user: "postgres",
    uptimeSeconds: 3600,
    charset: "UTF8",
    timeZone: "Etc/UTC",
  });
});
