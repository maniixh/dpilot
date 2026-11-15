import { expect, test } from "bun:test";
import { buildContainerSpec } from "../instances/engine-specs.ts";
import { authedHeaders, buildTestApp } from "../testing/build-app.ts";

const JSON_HEADERS = {
  ...authedHeaders,
  origin: `http://${authedHeaders.host}`,
  "content-type": "application/json",
};
const REF = { schema: "public", table: "grid" };
const KEY = encodeURIComponent(JSON.stringify({ id: "1" }));
const CELL = `schema=public&table=grid&column=img&key=${KEY}`;

function setup() {
  const ctx = buildTestApp();
  ctx.sql.respond(/relkind/, [{ kind: "r" }]);
  const column = { defaultValue: null, generated: "", identity: "" };
  ctx.sql.respond(/format_type/, [
    { ...column, name: "id", type: "bigint", typname: "int8", category: "N", nullable: false },
    { ...column, name: "note", type: "text", typname: "text", category: "S", nullable: true },
    { ...column, name: "img", type: "bytea", typname: "bytea", category: "U", nullable: true },
  ]);
  ctx.sql.respond(/indisunique/, [{ indexId: 1, column: "id" }]);
  const post = (path: string, body: unknown) =>
    ctx.app.request(`/api/c/s.orders${path}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  const addServer = () =>
    ctx.engine.addContainer({
      name: "dpilot-orders",
      spec: buildContainerSpec({
        name: "orders",
        engine: "postgres",
        version: "17",
        port: 5432,
        password: "pw",
        database: null,
      }),
      state: "running",
      health: "healthy",
      exitCode: 0,
    });
  addServer();
  return { ...ctx, post };
}

test("rejects a filter on an unknown column with 400", async () => {
  const { post, sql } = setup();
  const res = await post("/db/app/rows", {
    ref: REF,
    filters: [{ op: "eq", column: "nope", value: "1" }],
    search: null,
    sort: [],
    offset: 0,
    limit: 50,
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid_request" });
  expect(sql.calls.some((call) => /FROM "public"."grid"/.test(call.text))).toBe(false);
});

test("answers 403 for edits on a read-only connection", async () => {
  const { app, sql } = setup();
  const created = await app.request("/api/connections", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      label: "Prod",
      engine: "postgres",
      host: "db.example.com",
      port: 5432,
      username: "app",
      password: "pw",
      readOnly: true,
      tls: { mode: "off", ca: null },
    }),
  });
  const { id } = (await created.json()) as { id: string };
  const res = await app.request(`/api/c/c.${id}/db/app/rows/update`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ref: REF, key: { id: "1" }, values: { note: { set: "x" } } }),
  });
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ error: "read_only" });
  expect(sql.calls.some((call) => /UPDATE/.test(call.text))).toBe(false);
});

test("maps row and key conflicts to 404 and 409", async () => {
  const { post, sql } = setup();
  const body = { ref: REF, key: { id: "1" }, values: { note: { set: "x" } } };
  const missing = await post("/db/app/rows/update", body);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ error: "row_not_found" });
  sql.respondExecute(/FOR UPDATE/, {
    columns: ["1"],
    rows: [[1], [1]],
    command: null,
    affected: 2,
  });
  const twice = await post("/db/app/rows/update", body);
  expect(twice.status).toBe(409);
  expect(await twice.json()).toMatchObject({ error: "key_not_unique" });
});

test("counts rows", async () => {
  const { post, sql } = setup();
  sql.respondExecute(/count/i, { columns: ["count"], rows: [[7n]], command: null, affected: null });
  const res = await post("/db/app/rows/count", { ref: REF, filters: [], search: null });
  expect(await res.json()).toEqual({ count: 7 });
});

test("cell download sends the raw bytes as an attachment", async () => {
  const { app, sql } = setup();
  sql.respondExecute(/img/, {
    columns: ["img"],
    rows: [[Buffer.from([1, 2, 3])]],
    command: null,
    affected: null,
  });
  const res = await app.request(`/api/c/s.orders/db/app/cell?${CELL}`, {
    headers: authedHeaders,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/octet-stream");
  expect(res.headers.get("content-disposition")).toBe('attachment; filename="img.bin"');
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
});

test("rejects a malformed cell key with 400", async () => {
  const { app } = setup();
  const res = await app.request(
    `/api/c/s.orders/db/app/cell?schema=public&table=grid&column=img&key=%7Bnope`,
    { headers: authedHeaders },
  );
  expect(res.status).toBe(400);
});

test("cell upload writes the bytes in one locked update", async () => {
  const { app, sql } = setup();
  sql.respondExecute(/FOR UPDATE/, { columns: ["1"], rows: [[1]], command: null, affected: null });
  sql.respondExecute(/^UPDATE/, { columns: [], rows: [], command: "UPDATE", affected: 1 });
  const res = await app.request(`/api/c/s.orders/db/app/cell?${CELL}`, {
    method: "PUT",
    headers: { ...JSON_HEADERS, "content-type": "application/octet-stream" },
    body: new Uint8Array([9, 8]),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ affected: 1 });
});

test("rejects an upload over 16 MB with 413", async () => {
  const { app, sql } = setup();
  const res = await app.request(`/api/c/s.orders/db/app/cell?${CELL}`, {
    method: "PUT",
    headers: { ...JSON_HEADERS, "content-type": "application/octet-stream" },
    body: new Uint8Array(16 * 1024 * 1024 + 1),
  });
  expect(res.status).toBe(413);
  expect(await res.json()).toMatchObject({ error: "invalid_request" });
  expect(sql.calls.some((call) => /UPDATE/.test(call.text))).toBe(false);
});

test("serves completion names", async () => {
  const { app, sql } = setup();
  sql.respond(/information_schema/, [{ tableName: "grid", columnName: "id" }]);
  const res = await app.request("/api/c/s.orders/db/app/completion?schema=public", {
    headers: authedHeaders,
  });
  expect(await res.json()).toEqual({ tables: { grid: ["id"] } });
});
