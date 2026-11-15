import { beforeEach, expect, test } from "bun:test";
import type { ConnectionConfig } from "../connections/types.ts";
import { driverError, FakeSqlFactory } from "../testing/fake-sql.ts";
import { createMysqlAdapter } from "./mysql.ts";

const config: ConnectionConfig = {
  engine: "mysql",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  password: "x",
  database: null,
  tls: { mode: "off", ca: null },
  readOnly: false,
};
const ctx = { managed: false };
let sql: FakeSqlFactory;
beforeEach(() => {
  sql = new FakeSqlFactory();
});

test("marks system databases", async () => {
  sql.respond(/SHOW DATABASES/, [{ Database: "app" }, { Database: "mysql" }, { Database: "sys" }]);
  const dbs = await createMysqlAdapter(config, sql.factory, ctx).databases();
  expect(dbs).toEqual([
    { name: "app", system: false, browsable: true },
    { name: "mysql", system: true, browsable: true },
    { name: "sys", system: true, browsable: true },
  ]);
});

test("groups tables, views and routines", async () => {
  sql.respond(/TABLES/, [
    { name: "orders", type: "BASE TABLE" },
    { name: "totals", type: "VIEW" },
  ]);
  sql.respond(/ROUTINES/, [
    { name: "refresh", type: "PROCEDURE" },
    { name: "tax", type: "FUNCTION" },
  ]);
  const groups = await createMysqlAdapter(config, sql.factory, ctx).objects("app", null);
  expect(groups).toEqual({
    tables: ["orders"],
    views: ["totals"],
    procedures: ["refresh"],
    functions: ["tax"],
  });
});

test("passes the database only as a parameter", async () => {
  const name = 'we`ird"db';
  await createMysqlAdapter(config, sql.factory, ctx).objects(name, null);
  expect(sql.calls.length).toBeGreaterThan(0);
  for (const call of sql.calls) {
    expect(call.params).toEqual([name]);
    expect(call.text).not.toContain(name);
  }
});

test("falls back to the default database when listing is denied", async () => {
  sql.respond(/SHOW DATABASES/, driverError({ errno: 1227 }));
  const adapter = createMysqlAdapter({ ...config, database: "app" }, sql.factory, ctx);
  expect(await adapter.databases()).toEqual([{ name: "app", system: false, browsable: true }]);
});

test("rethrows a denied listing when there is no default database", async () => {
  sql.respond(/SHOW DATABASES/, driverError({ errno: 1227 }, "denied"));
  const adapter = createMysqlAdapter(config, sql.factory, ctx);
  await expect(adapter.databases()).rejects.toMatchObject({ code: "query_failed" });
});

test("classifies driver errors", async () => {
  sql.respond(/SHOW DATABASES/, driverError({ errno: 1045 }));
  const adapter = createMysqlAdapter(config, sql.factory, ctx);
  await expect(adapter.databases()).rejects.toMatchObject({ code: "auth_failed" });
});

test("reports info", async () => {
  sql.respond(/VERSION\(\)/, [
    { version: "8.4.3", user: "root@%", charset: "utf8mb4", timeZone: "SYSTEM" },
  ]);
  sql.respond(/Uptime/, [{ Variable_name: "Uptime", Value: "3600" }]);
  expect(await createMysqlAdapter(config, sql.factory, ctx).info()).toEqual({
    engine: "mysql",
    version: "8.4.3",
    user: "root@%",
    uptimeSeconds: 3600,
    charset: "utf8mb4",
    timeZone: "SYSTEM",
  });
});

test("lists variables without descriptions", async () => {
  sql.respond(/SHOW GLOBAL VARIABLES/, [{ Variable_name: "port", Value: "3306" }]);
  expect(await createMysqlAdapter(config, sql.factory, ctx).variables()).toEqual([
    { name: "port", value: "3306", description: null },
  ]);
});

test("uses one client and closes it", async () => {
  const adapter = createMysqlAdapter({ ...config, database: "app" }, sql.factory, ctx);
  await adapter.databases();
  await adapter.objects("app", null);
  await adapter.close();
  expect(sql.created).toEqual(["app"]);
  expect(sql.closed).toEqual(["app"]);
});
