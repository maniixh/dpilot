import { expect, test } from "bun:test";
import { authedHeaders, buildTestApp } from "../testing/build-app.ts";

const JSON_HEADERS = {
  ...authedHeaders,
  origin: `http://${authedHeaders.host}`,
  "content-type": "application/json",
};

function setup() {
  const ctx = buildTestApp();
  const send = (method: string, path: string, body?: unknown) =>
    ctx.app.request(`/api${path}`, {
      method,
      headers: JSON_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const addHistory = (sql: string, target = ONE) =>
    ctx.deps.history.add({
      target,
      database: null,
      sql,
      startedAt: "2026-11-15T00:00:00.000Z",
      durationMs: 5,
      outcome: "ok",
      statements: 1,
      rowsAffected: 0,
      error: null,
    });
  return { ...ctx, send, addHistory };
}

const ONE = "c.00000000-0000-4000-8000-000000000001";
const TWO = "c.00000000-0000-4000-8000-000000000002";
const SAVED = { name: "Orders", target: ONE, database: "app", sql: "SELECT 1" };

test("history search coerces limit and before from the query string", async () => {
  const { send, addHistory } = setup();
  const oldest = addHistory("SELECT * FROM orders");
  addHistory("SELECT * FROM users");
  const newest = addHistory("SELECT * FROM orders WHERE id = 1");
  const res = await send("GET", `/history?search=orders&limit=5&before=${newest.id}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: number }[];
  expect(body.map((e) => e.id)).toEqual([oldest.id]);
});

test("history rejects a non-numeric limit with 400", async () => {
  const { send } = setup();
  const res = await send("GET", "/history?limit=abc");
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid_request" });
});

test("history deletes one entry or one target's entries", async () => {
  const { send, addHistory } = setup();
  const first = addHistory("SELECT 1");
  addHistory("SELECT 2");
  addHistory("SELECT 3", TWO);
  expect((await send("DELETE", `/history/${first.id}`)).status).toBe(204);
  expect((await send("DELETE", `/history?target=${ONE}`)).status).toBe(204);
  const left = (await (await send("GET", "/history")).json()) as { target: string }[];
  expect(left.map((e) => e.target)).toEqual([TWO]);
  expect((await send("DELETE", "/history")).status).toBe(204);
  expect(await (await send("GET", "/history")).json()).toEqual([]);
});

test("saved query CRUD", async () => {
  const { send } = setup();
  const created = await send("POST", "/saved-queries", SAVED);
  expect(created.status).toBe(201);
  const saved = (await created.json()) as { id: string; name: string };
  expect(saved.name).toBe("Orders");

  expect(await (await send("GET", "/saved-queries")).json()).toHaveLength(1);

  const patched = await send("PATCH", `/saved-queries/${saved.id}`, { name: "Orders v2" });
  expect(patched.status).toBe(200);
  expect(await patched.json()).toMatchObject({ id: saved.id, name: "Orders v2", sql: "SELECT 1" });

  expect((await send("DELETE", `/saved-queries/${saved.id}`)).status).toBe(204);
  expect(await (await send("GET", "/saved-queries")).json()).toEqual([]);
});

test("saved query answers 409 for a taken name and 404 for an unknown id", async () => {
  const { send } = setup();
  await send("POST", "/saved-queries", SAVED);
  const dup = await send("POST", "/saved-queries", SAVED);
  expect(dup.status).toBe(409);
  expect(await dup.json()).toMatchObject({ error: "name_taken" });

  const missing = "33333333-3333-4333-8333-333333333333";
  const patch = await send("PATCH", `/saved-queries/${missing}`, { name: "x" });
  expect(patch.status).toBe(404);
  expect(await patch.json()).toMatchObject({ error: "not_found" });
  expect((await send("DELETE", `/saved-queries/${missing}`)).status).toBe(404);
});

test("saved query rejects an invalid body with 400", async () => {
  const { send } = setup();
  const res = await send("POST", "/saved-queries", { ...SAVED, name: " " });
  expect(res.status).toBe(400);
});
