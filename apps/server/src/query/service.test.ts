import { describe, expect, test } from "bun:test";
import type { EngineId, QueryRequest } from "@dpilot/shared";
import type { ConnectionConfig } from "../connections/types.ts";
import { DataError, TargetError } from "../engines/types.ts";
import { openStore } from "../store/database.ts";
import { createHistoryStore } from "../store/history.ts";
import { FakeSession } from "../testing/fake-session.ts";
import { driverError } from "../testing/fake-sql.ts";
import { createQueryService } from "./service.ts";
import type { SqlSessionFactory } from "./types.ts";

const TARGET = "c.one";
const TAB = "11111111-1111-4111-8111-111111111111";
const ROW_RESULT = { columns: ["n"], rows: [[1]], command: null, affected: 1 };

interface Options {
  readOnly?: boolean;
  engine?: EngineId;
  failOpen?: boolean;
  session?: FakeSession;
  /** Sessions handed out in order, one per open. */
  queue?: FakeSession[];
}

function setup(options: Options = {}) {
  const opened: { session: FakeSession; database: string | null }[] = [];
  const factory: SqlSessionFactory = async (_config, database) => {
    if (options.failOpen) throw driverError({ code: "ECONNREFUSED" }, "connect failed");
    const session = options.queue?.shift() ?? options.session ?? new FakeSession();
    opened.push({ session, database });
    return session;
  };
  const history = createHistoryStore(openStore(":memory:"));
  const clock = { now: 1_000 };
  const config: ConnectionConfig = {
    engine: options.engine ?? "mysql",
    host: "db",
    port: 3306,
    username: "app",
    password: "pw",
    database: null,
    tls: { mode: "off", ca: null },
    readOnly: options.readOnly ?? false,
  };
  const service = createQueryService({
    resolve: async () => ({
      config,
      ctx: { managed: false, readOnly: config.readOnly },
    }),
    sessions: factory,
    history,
    now: () => clock.now,
    idleMs: 600_000,
  });
  return { service, opened, history, clock };
}

let counter = 0;
function request(sql: string, over: Partial<QueryRequest> = {}): QueryRequest {
  counter += 1;
  return {
    runId: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    sql,
    database: "app",
    tab: TAB,
    maxRows: 1000,
    confirmed: false,
    ...over,
  };
}

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(1);
  if (!condition()) throw new Error("condition never became true");
}

describe("QueryService", () => {
  test("asks for confirmation before a DELETE without WHERE and runs nothing", async () => {
    const { service, opened } = setup();
    const failure = await service.run(TARGET, request("DELETE FROM t")).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DataError);
    expect(failure).toMatchObject({ code: "confirmation_required" });
    const statements = (failure as DataError).statements;
    expect(statements).toHaveLength(1);
    expect(statements?.[0]).toMatchObject({ index: 0, sql: "DELETE FROM t" });
    expect(statements?.[0]?.reasons.length).toBeGreaterThan(0);
    expect(opened).toHaveLength(0);
  });

  test("runs once confirmed", async () => {
    const { service, opened } = setup();
    const run = await service.run(TARGET, request("DELETE FROM t", { confirmed: true }));
    expect(run.stopped).toBeNull();
    expect(opened[0]?.session.executed).toEqual(["DELETE FROM t"]);
  });

  test("refuses a data-modifying CTE on a read-only connection", async () => {
    const { service, opened } = setup({ readOnly: true, engine: "postgres" });
    const sql = "WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone";
    await expect(service.run(TARGET, request(sql, { confirmed: true }))).rejects.toMatchObject({
      code: "read_only",
    });
    expect(opened).toHaveLength(0);
  });

  test("refuses SET on a read-only connection", async () => {
    const { service, opened } = setup({ readOnly: true });
    await expect(service.run(TARGET, request("SET @a = 1"))).rejects.toMatchObject({
      code: "read_only",
      message: expect.stringContaining("SET @a = 1"),
    });
    expect(opened).toHaveLength(0);
  });

  test("rejects an empty script", async () => {
    const { service } = setup();
    await expect(service.run(TARGET, request("  -- nothing\n"))).rejects.toMatchObject({
      code: "invalid_request",
      message: "Nothing to run.",
    });
  });

  test("rejects a second run on a busy tab", async () => {
    const session = new FakeSession();
    const { service } = setup({ session });
    const gate = deferred();
    session.hold(/SELECT 1/, gate.promise);
    const first = service.run(TARGET, request("SELECT 1"));
    await until(() => session.executed.length === 1);
    await expect(service.run(TARGET, request("SELECT 2"))).rejects.toMatchObject({
      code: "busy",
    });
    gate.release();
    expect((await first).stopped).toBeNull();
  });

  test("cancel stops the in-flight statement and skips the rest", async () => {
    const session = new FakeSession();
    const { service } = setup({ session });
    const gate = deferred();
    const run = request("SELECT 1; SELECT 2; SELECT 3");
    session.hold(/SELECT 2/, gate.promise);
    session.respond(/SELECT 2/, new Error("Query execution was interrupted"));
    const first = service.run(TARGET, run);
    await until(() => session.executed.includes("SELECT 2"));
    const cancelled = service.cancel(TARGET, run.runId);
    gate.release();
    await cancelled;
    const result = await first;
    expect(result.stopped).toBe("cancelled");
    expect(session.cancelled).toEqual(["SELECT 2"]);
    expect(session.executed).not.toContain("SELECT 3");
  });

  test("a cancel that settles late does not touch the next run", async () => {
    const session = new FakeSession();
    const { service } = setup({ session });
    const gate = deferred();
    const cancelSettles = deferred();
    const run = request("SELECT slow");
    session.hold(/slow/, gate.promise);
    session.delayCancel(cancelSettles.promise);
    session.respond(/SELECT 2/, ROW_RESULT);
    const first = service.run(TARGET, run);
    await until(() => session.executed.includes("SELECT slow"));
    const cancelled = service.cancel(TARGET, run.runId);
    gate.release();
    await Bun.sleep(5);
    let firstSent = false;
    void first.then(() => {
      firstSent = true;
    });
    const second = service.run(TARGET, request("SELECT 2"));
    await Bun.sleep(10);
    expect(firstSent).toBe(false);
    expect(session.executed).not.toContain("SELECT 2");
    cancelSettles.release();
    await cancelled;
    expect((await second).stopped).toBeNull();
    await first;
    expect(session.cancelled).toEqual(["SELECT slow"]);
    expect(session.executed.at(-1)).toBe("SELECT 2");
  });

  test("refuses an 11th tab on a target but still serves the open ones", async () => {
    const { service, opened } = setup();
    const tab = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
    for (let n = 1; n <= 10; n++) await service.run(TARGET, request("SELECT 1", { tab: tab(n) }));
    await expect(service.run(TARGET, request("SELECT 1", { tab: tab(11) }))).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(opened).toHaveLength(10);
    await service.run(TARGET, request("SELECT 1", { tab: tab(3) }));
    await service.run("c.two", request("SELECT 1", { tab: tab(11) }));
    await service.closeTab(TARGET, tab(1));
    await service.run(TARGET, request("SELECT 1", { tab: tab(11) }));
  });

  test("rejects a run id that is already in flight on another tab", async () => {
    const session = new FakeSession();
    const { service } = setup({ session });
    const gate = deferred();
    session.hold(/SELECT 1/, gate.promise);
    const first = request("SELECT 1");
    const running = service.run(TARGET, first);
    await until(() => session.executed.length === 1);
    const other = "22222222-2222-4222-8222-222222222222";
    await expect(
      service.run(TARGET, { ...request("SELECT 2", { tab: other }), runId: first.runId }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    gate.release();
    await running;
  });

  test("answers run_not_found for an unknown or finished run", async () => {
    const { service } = setup();
    const run = request("SELECT 1");
    await expect(service.cancel(TARGET, run.runId)).rejects.toMatchObject({
      code: "run_not_found",
    });
    await service.run(TARGET, run);
    await expect(service.cancel(TARGET, run.runId)).rejects.toMatchObject({
      code: "run_not_found",
    });
  });

  test("reopens the session when the database changes", async () => {
    const { service, opened } = setup();
    await service.run(TARGET, request("SELECT 1", { database: "a" }));
    await service.run(TARGET, request("SELECT 1", { database: "a" }));
    expect(opened).toHaveLength(1);
    await service.run(TARGET, request("SELECT 1", { database: "b" }));
    expect(opened.map((o) => o.database)).toEqual(["a", "b"]);
    expect(opened[0]?.session.closed).toBe(true);
    expect(opened[1]?.session.closed).toBe(false);
  });

  test("drops a session whose connection was lost and opens a new one next run", async () => {
    const dead = new FakeSession();
    const fresh = new FakeSession();
    const { service, opened } = setup({ queue: [dead, fresh] });
    dead.respond(
      /SELECT 1/,
      Object.assign(new Error("Connection closed"), { code: "ERR_MYSQL_CONNECTION_CLOSED" }),
    );
    const first = await service.run(TARGET, request("SELECT 1; SELECT 2"));
    expect(first.stopped).toBe("error");
    const failed = first.outcomes[0];
    expect(failed?.kind === "error" ? failed.message : "").toContain("new session");
    expect(dead.closed).toBe(true);
    const second = await service.run(TARGET, request("SELECT 3"));
    expect(second.stopped).toBeNull();
    expect(opened).toHaveLength(2);
    expect(fresh.executed).toEqual(["SELECT 3"]);
  });

  test("keeps a session after an ordinary statement error", async () => {
    const session = new FakeSession();
    const { service, opened } = setup({ session });
    session.respond(/SELEC /, Object.assign(new Error("syntax"), { errno: 1064 }));
    await service.run(TARGET, request("SELEC 1"));
    await service.run(TARGET, request("SELECT 1"));
    expect(opened).toHaveLength(1);
    expect(session.closed).toBe(false);
  });

  test("closes idle sessions", async () => {
    const { service, opened, clock } = setup();
    await service.run(TARGET, request("SELECT 1"));
    clock.now += 599_000;
    await service.sweep();
    expect(opened[0]?.session.closed).toBe(false);
    clock.now += 2_000;
    await service.sweep();
    expect(opened[0]?.session.closed).toBe(true);
  });

  test("closes a tab, a target and everything", async () => {
    const { service, opened } = setup();
    const other = "22222222-2222-4222-8222-222222222222";
    await service.run(TARGET, request("SELECT 1"));
    await service.run(TARGET, request("SELECT 1", { tab: other }));
    await service.run("c.two", request("SELECT 1"));
    await service.closeTab(TARGET, TAB);
    expect(opened.map((o) => o.session.closed)).toEqual([true, false, false]);
    await service.closeTarget(TARGET);
    expect(opened.map((o) => o.session.closed)).toEqual([true, true, false]);
    await service.closeAll();
    expect(opened.every((o) => o.session.closed)).toBe(true);
  });

  test("records history with redacted SQL", async () => {
    const { service, history } = setup();
    await service.run(TARGET, request("CREATE USER u IDENTIFIED BY 'hunter2'"));
    const [entry] = history.list({ limit: 10 });
    expect(entry).toMatchObject({ target: TARGET, database: "app", outcome: "ok", statements: 1 });
    expect(entry?.sql).not.toContain("hunter2");
  });

  test("records failed and cancelled runs in history", async () => {
    const session = new FakeSession();
    const { service, history } = setup({ session });
    await service.run(TARGET, request("SELECT 1"));
    session.respond(/boom/, new Error("boom failed"));
    await service.run(TARGET, request("SELECT boom"));
    const run = request("SELECT slow");
    const gate = deferred();
    session.hold(/slow/, gate.promise);
    session.respond(/slow/, new Error("interrupted"));
    const pending = service.run(TARGET, run);
    await until(() => session.executed.includes("SELECT slow"));
    const cancelled = service.cancel(TARGET, run.runId);
    gate.release();
    await Promise.all([pending, cancelled]);
    expect(history.list({ limit: 10 }).map((e) => e.outcome)).toEqual(["cancelled", "error", "ok"]);
    expect(history.list({ limit: 1 })[0]).toMatchObject({ error: "interrupted" });
  });

  test("maps a failed connection to a target error and records it", async () => {
    const { service, history } = setup({ failOpen: true });
    const failure = await service.run(TARGET, request("SELECT 1")).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TargetError);
    expect(failure).toMatchObject({ code: "unreachable" });
    expect(history.list({ limit: 5 })).toMatchObject([{ outcome: "error", statements: 0 }]);
  });
});
