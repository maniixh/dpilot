import { expect, test } from "bun:test";
import { buildContainerSpec } from "../instances/engine-specs.ts";
import { authedHeaders, buildTestApp } from "../testing/build-app.ts";

const JSON_HEADERS = {
  ...authedHeaders,
  origin: `http://${authedHeaders.host}`,
  "content-type": "application/json",
};
const TAB = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

function setup() {
  const ctx = buildTestApp();
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
  const send = (method: string, path: string, body?: unknown) =>
    ctx.app.request(`/api/c/s.orders${path}`, {
      method,
      headers: JSON_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const run = (sql: string, over: Record<string, unknown> = {}) =>
    send("POST", "/query", {
      runId: RUN,
      sql,
      database: "app",
      tab: TAB,
      maxRows: 1000,
      confirmed: false,
      ...over,
    });
  return { ...ctx, send, run };
}

test("409 confirmation_required lists statements", async () => {
  const { run, sessions } = setup();
  const res = await run("SELECT 1; DELETE FROM t");
  expect(res.status).toBe(409);
  const body = (await res.json()) as { statements: { reasons: string[] }[]; message: string };
  expect(body).toMatchObject({
    error: "confirmation_required",
    statements: [{ index: 1, sql: "DELETE FROM t" }],
  });
  expect(body.statements[0]?.reasons.length).toBeGreaterThan(0);
  expect(typeof body.message).toBe("string");
  expect(sessions).toHaveLength(0);
});

test("runs a script and returns the outcomes", async () => {
  const { run, sessions } = setup();
  const res = await run("SELECT 1");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    runId: RUN,
    stopped: null,
    summary: { statements: 1, succeeded: 1 },
  });
  expect(sessions[0]?.session.executed).toEqual(["SELECT 1"]);
});

test("rejects a malformed run request with 400", async () => {
  const { send } = setup();
  const res = await send("POST", "/query", { sql: "SELECT 1" });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid_request" });
});

test("rejects an empty script with 400", async () => {
  const { run } = setup();
  const res = await run("   ");
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid_request", message: "Nothing to run." });
});

test("cancel answers 404 run_not_found for an unknown run", async () => {
  const { send } = setup();
  const res = await send("POST", `/query/${RUN}/cancel`);
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ error: "run_not_found" });
});

test("updating or deleting a connection closes its query sessions", async () => {
  const { app, sessions } = buildTestApp();
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: JSON_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const created = await call("POST", "/api/connections", {
    label: "Prod",
    engine: "mysql",
    host: "db.example.com",
    port: 3306,
    username: "app",
    password: "pw",
    tls: { mode: "off", ca: null },
  });
  const { id } = (await created.json()) as { id: string };
  const run = (runId: string) =>
    call("POST", `/api/c/c.${id}/query`, {
      runId,
      sql: "SELECT 1",
      database: "app",
      tab: TAB,
      maxRows: 1000,
      confirmed: false,
    });
  expect((await run(RUN)).status).toBe(200);
  await call("PATCH", `/api/connections/${id}`, { readOnly: true });
  await Bun.sleep(5);
  expect(sessions[0]?.session.closed).toBe(true);
  expect((await run("33333333-3333-4333-8333-333333333333")).status).toBe(200);
  await call("DELETE", `/api/connections/${id}`);
  await Bun.sleep(5);
  expect(sessions[1]?.session.closed).toBe(true);
});

test("closing a tab answers 204 and closes its session", async () => {
  const { run, send, sessions } = setup();
  await run("SELECT 1");
  const res = await send("DELETE", `/sessions/${TAB}`);
  expect(res.status).toBe(204);
  expect(sessions[0]?.session.closed).toBe(true);
});
