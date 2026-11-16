import { describe, expect, test } from "bun:test";
import type { QueryRequest, QueryRun, StatementOutcome } from "@dpilot/shared";
import { MAX_SCRIPT_BYTES } from "@dpilot/shared";
import { ApiError } from "../../api/client.ts";
import {
  beginRun,
  buildRunRequest,
  confirmedRequest,
  declineConfirmation,
  describeRunError,
  errorRange,
  explainStatement,
  failRun,
  gapLabel,
  isBusy,
  markCancelling,
  outcomeTitle,
  planFileRun,
  type RunPhase,
  runSummary,
  runTarget,
  settleRun,
  windowOutcomes,
} from "./editor-model.ts";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const NEXT_ID = "22222222-2222-4222-8222-222222222222";
const TAB_ID = "33333333-3333-4333-8333-333333333333";
const DOC = "SELECT 1;\nSELECT 2;\nSELECT 3";

function rows(index: number, count: number): StatementOutcome {
  return {
    index,
    sql: "SELECT",
    durationMs: 1,
    kind: "rows",
    columns: [],
    rows: Array.from({ length: count }, () => []),
    truncated: false,
  };
}

function request(sql = "DELETE FROM t"): QueryRequest {
  return buildRunRequest({
    runId: RUN_ID,
    tab: TAB_ID,
    sql,
    database: "shop",
    maxRows: 1000,
    confirmed: false,
  });
}

const source = { sql: "DELETE FROM t", offset: 0 };
const IDLE: RunPhase = { phase: "idle" };

function run(partial: Partial<QueryRun> = {}): QueryRun {
  return {
    runId: RUN_ID,
    outcomes: [],
    omitted: 0,
    summary: { statements: 0, succeeded: 0, affected: 0 },
    stopped: null,
    durationMs: 0,
    ...partial,
  };
}

describe("runTarget", () => {
  test("uses the statement at the cursor", () => {
    expect(runTarget(DOC, { from: 12, to: 12 }, "mysql", "selection")).toEqual({
      sql: "SELECT 2",
      offset: 10,
    });
  });

  test("uses the selection when there is one", () => {
    expect(runTarget(DOC, { from: 7, to: 19 }, "postgres", "selection")).toEqual({
      sql: DOC.slice(7, 19),
      offset: 7,
    });
  });

  test("runs the whole document for run all", () => {
    expect(runTarget(DOC, { from: 12, to: 12 }, "mysql", "all")).toEqual({ sql: DOC, offset: 0 });
  });

  test("gives an empty script when there is nothing to run", () => {
    expect(runTarget("  \n", { from: 0, to: 0 }, "mysql", "selection").sql).toBe("");
  });
});

describe("explainStatement", () => {
  test("wraps the statement for the dialect and drops the editor offset", () => {
    expect(explainStatement({ sql: " SELECT 1 ", offset: 4 }, "mysql")).toEqual({
      sql: "EXPLAIN SELECT 1",
      offset: 0,
    });
    expect(explainStatement({ sql: "SELECT 1", offset: 4 }, "postgres").sql).toBe(
      "EXPLAIN (FORMAT TEXT) SELECT 1",
    );
  });

  test("leaves an empty script empty", () => {
    expect(explainStatement({ sql: "  ", offset: 0 }, "mysql").sql).toBe("");
  });
});

describe("errorRange", () => {
  test("offsets by the statement start and covers the word at the position", () => {
    const statement = { text: "SELECT 2", start: 10 };
    const outcome: StatementOutcome = {
      index: 1,
      sql: statement.text,
      durationMs: 1,
      kind: "error",
      message: "x",
      position: 7,
    };
    expect(errorRange(statement, outcome)).toEqual({ from: 17, to: 18 });
    expect(errorRange({ text: "SELEC 1", start: 0 }, { ...outcome, position: 0 })).toEqual({
      from: 0,
      to: 5,
    });
    expect(errorRange(statement, outcome, 100)).toEqual({ from: 117, to: 118 });
  });

  test("is null without a position or past the statement", () => {
    const statement = { text: "SELECT", start: 0 };
    const base = { index: 0, sql: "SELECT", durationMs: 1 };
    expect(
      errorRange(statement, { ...base, kind: "error", message: "x", position: null }),
    ).toBeNull();
    expect(errorRange(statement, { ...base, kind: "error", message: "x", position: 9 })).toBeNull();
    expect(errorRange(statement, rows(0, 1))).toBeNull();
  });
});

describe("outcomeTitle", () => {
  test("labels rows, affected counts and errors", () => {
    expect(outcomeTitle(rows(0, 12))).toBe("Result 1 · 12 rows");
    expect(outcomeTitle(rows(0, 1))).toBe("Result 1 · 1 row");
    const base = { index: 1, sql: "", durationMs: 1 };
    expect(outcomeTitle({ ...base, kind: "affected", command: "UPDATE", affected: 3 })).toBe(
      "Statement 2 · 3 rows affected",
    );
    expect(outcomeTitle({ ...base, kind: "affected", command: "UPDATE", affected: 1 })).toBe(
      "Statement 2 · 1 row affected",
    );
    expect(
      outcomeTitle({ ...base, index: 2, kind: "error", message: "boom", position: null }),
    ).toBe("Statement 3 · Error");
  });
});

describe("windowOutcomes", () => {
  test("puts a gap note between the first 50 and the last 50", () => {
    const outcomes = [
      ...Array.from({ length: 50 }, (_, i) => rows(i, 1)),
      ...Array.from({ length: 50 }, (_, i) => rows(i + 97, 1)),
    ];
    const items = windowOutcomes(run({ outcomes, omitted: 47 }));
    expect(items).toHaveLength(101);
    expect(items[50]).toEqual({ kind: "gap", omitted: 47, from: 51, to: 97 });
    expect(gapLabel({ omitted: 47, from: 51, to: 97 })).toBe(
      "47 results not shown (statements 51 to 97)",
    );
    expect(gapLabel({ omitted: 1, from: 51, to: 51 })).toBe("1 result not shown (statement 51)");
  });

  test("has no gap when nothing was dropped", () => {
    const items = windowOutcomes(run({ outcomes: [rows(0, 1), rows(1, 1)] }));
    expect(items.map((item) => item.kind)).toEqual(["outcome", "outcome"]);
  });
});

describe("runSummary", () => {
  test("states successes, rows affected, why it stopped and the time", () => {
    expect(
      runSummary(run({ summary: { statements: 3, succeeded: 3, affected: 5 }, durationMs: 12 })),
    ).toBe("3 of 3 statements succeeded · 5 rows affected · 12 ms");
    expect(
      runSummary(
        run({
          summary: { statements: 2, succeeded: 1, affected: 0 },
          stopped: "error",
          durationMs: 1500,
        }),
      ),
    ).toBe("1 of 2 statements succeeded · stopped at an error · 1.5 s");
    expect(
      runSummary(
        run({
          summary: { statements: 1, succeeded: 0, affected: 0 },
          stopped: "cancelled",
          durationMs: 80,
        }),
      ),
    ).toBe("0 of 1 statement succeeded · cancelled · 80 ms");
  });
});

describe("buildRunRequest", () => {
  test("keeps the ids, database and limits", () => {
    expect(request("SELECT 1")).toEqual({
      runId: RUN_ID,
      tab: TAB_ID,
      sql: "SELECT 1",
      database: "shop",
      maxRows: 1000,
      confirmed: false,
    });
  });
});

describe("run state", () => {
  test("a confirmation flow re-runs the same script with confirmed true", () => {
    const running = beginRun(IDLE, request(), source);
    expect(isBusy(running)).toBe(true);
    const asked = settleRun(running, {
      kind: "confirm",
      statements: [{ index: 0, sql: "DELETE FROM t", reasons: ["DELETE without WHERE"] }],
    });
    expect(asked.phase).toBe("confirm");
    expect(isBusy(asked)).toBe(false);
    const again = confirmedRequest(asked, NEXT_ID);
    expect(again).toEqual({ ...request(), runId: NEXT_ID, confirmed: true });
    expect(confirmedRequest(IDLE, NEXT_ID)).toBeNull();
  });

  test("declining restores what the tab showed before", () => {
    const done = settleRun(beginRun(IDLE, request("SELECT 1"), source), {
      kind: "run",
      run: run(),
    });
    const asked = settleRun(beginRun(done, request(), source), {
      kind: "confirm",
      statements: [],
    });
    expect(declineConfirmation(asked)).toEqual(done);
  });

  test("cancelling keeps the tab busy until the run settles", () => {
    const running = beginRun(IDLE, request(), source);
    const cancelling = markCancelling(running);
    expect(cancelling).toMatchObject({ phase: "running", cancelling: true });
    expect(isBusy(cancelling)).toBe(true);
    const settled = settleRun(cancelling, { kind: "run", run: run({ stopped: "cancelled" }) });
    expect(settled.phase).toBe("done");
    expect(isBusy(settled)).toBe(false);
    expect(markCancelling(IDLE)).toEqual(IDLE);
  });

  test("a failed request frees the tab with a message", () => {
    const failed = failRun(
      beginRun(IDLE, request(), source),
      new ApiError(409, "busy", "A query is already running in this tab."),
    );
    expect(failed).toEqual({
      phase: "failed",
      message: "This tab is still running a query. Wait for it to finish or cancel it.",
    });
    expect(isBusy(failed)).toBe(false);
  });
});

describe("describeRunError", () => {
  test("explains the server's refusals", () => {
    expect(describeRunError(new ApiError(404, "run_not_found", null))).toBe(
      "That run has already finished.",
    );
    expect(describeRunError(new ApiError(400, "invalid_request", "Too many tabs"))).toBe(
      "Too many tabs",
    );
    expect(describeRunError(new ApiError(403, "read_only", "This connection is read-only."))).toBe(
      "This connection is read-only.",
    );
    expect(describeRunError(new TypeError("fetch failed"))).toBe(
      "Dpilot couldn't reach its server to run this.",
    );
  });
});

describe("planFileRun", () => {
  test("opens small files in a tab, runs big ones directly and rejects oversize files", () => {
    expect(planFileRun(10_000, 3)).toEqual({ kind: "tab" });
    expect(planFileRun(10_000, 10)).toEqual({ kind: "direct" });
    expect(planFileRun(2 * 1024 * 1024, 1)).toEqual({ kind: "direct" });
    expect(planFileRun(MAX_SCRIPT_BYTES, 1)).toEqual({ kind: "direct" });
    expect(planFileRun(MAX_SCRIPT_BYTES + 1, 1).kind).toBe("reject");
    expect(planFileRun(20 * 1024 * 1024, 1)).toEqual({
      kind: "reject",
      message: "That file is 20.0 MB. Dpilot runs scripts of up to 16 MB.",
    });
    expect(planFileRun(0, 1)).toEqual({ kind: "reject", message: "That file is empty." });
  });
});
