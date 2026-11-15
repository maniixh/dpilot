import {
  type CellValue,
  type ColumnKind,
  classifyStatement,
  type Dialect,
  type QueryRun,
  type SqlStatement,
  type StatementOutcome,
} from "@dpilot/shared";
import { encodeCell } from "../engines/cells.ts";
import { DataError, type SqlResult } from "../engines/types.ts";
import type { SqlSession } from "./types.ts";

const KEPT_AT_EACH_END = 50;
const MAX_OUTCOME_SQL_CHARS = 2000;
const READ_ONLY_BEGIN = { mysql: "START TRANSACTION READ ONLY", postgres: "BEGIN READ ONLY" };

export interface RunOptions {
  maxRows: number;
  readOnly: boolean;
  dialect: Dialect;
  /** Polled before each statement; once true nothing further starts. */
  isCancelled: () => boolean;
  now: () => number;
}

type Outcome = StatementOutcome;

function kindOf(value: unknown): ColumnKind {
  if (typeof value === "bigint") return "integer";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "float";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "text";
  if (value instanceof Date) return "datetime";
  if (value instanceof Uint8Array) return "binary";
  if (typeof value === "object" && value !== null) return "json";
  return "other";
}

function columnKinds(result: SqlResult): ColumnKind[] {
  return result.columns.map((_, index) => {
    const row = result.rows.find((candidate) => candidate[index] != null);
    return row === undefined ? "other" : kindOf(row[index]);
  });
}

function errorPosition(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("position" in error)) return null;
  const position = Number(error.position);
  return Number.isInteger(position) && position > 0 ? position - 1 : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Retains the first and last 50 outcomes while counting the ones dropped between. */
class OutcomeWindow {
  private readonly head: Outcome[] = [];
  private readonly tail: Outcome[] = [];
  omitted = 0;

  add(outcome: Outcome): void {
    if (this.head.length < KEPT_AT_EACH_END) {
      this.head.push(outcome);
      return;
    }
    this.tail.push(outcome);
    if (this.tail.length > KEPT_AT_EACH_END) {
      this.tail.shift();
      this.omitted += 1;
    }
  }

  toArray(): Outcome[] {
    return [...this.head, ...this.tail];
  }
}

function toOutcome(
  base: { index: number; sql: string; durationMs: number },
  result: SqlResult,
  maxRows: number,
): Outcome {
  if (result.columns.length === 0) {
    return { ...base, kind: "affected", command: result.command, affected: result.affected ?? 0 };
  }
  const rows: CellValue[][] = result.rows.slice(0, maxRows).map((row) => row.map(encodeCell));
  const kinds = columnKinds(result);
  return {
    ...base,
    kind: "rows",
    columns: result.columns.map((name, i) => ({ name, kind: kinds[i] ?? "other" })),
    rows,
    truncated: result.rows.length > maxRows,
  };
}

/** Runs one statement, inside a server-owned rolled-back transaction when read-only. */
async function executeOne(
  session: SqlSession,
  text: string,
  options: RunOptions,
): Promise<SqlResult> {
  if (!options.readOnly) return session.execute(text);
  await session.execute(READ_ONLY_BEGIN[options.dialect]);
  let failure: { error: unknown } | null = null;
  let result: SqlResult | null = null;
  try {
    result = await session.execute(text);
  } catch (error) {
    failure = { error };
  }
  try {
    await session.execute("ROLLBACK");
  } catch (error) {
    failure ??= { error };
  }
  if (failure !== null) throw failure.error;
  return result as SqlResult;
}

function refuseNonReads(statements: SqlStatement[], dialect: Dialect): void {
  const refused = statements.find((s) => classifyStatement(s.text, dialect) !== "read");
  if (refused === undefined) return;
  const preview = refused.text.slice(0, 80);
  throw new DataError("read_only", `This connection is read-only. Refused: ${preview}`);
}

/** Runs split statements in order, stopping at the first error or once cancelled. */
export async function runScript(
  session: SqlSession,
  statements: SqlStatement[],
  options: RunOptions,
): Promise<Omit<QueryRun, "runId">> {
  if (options.readOnly) refuseNonReads(statements, options.dialect);
  const runStart = options.now();
  const window = new OutcomeWindow();
  const summary = { statements: 0, succeeded: 0, affected: 0 };
  let stopped: QueryRun["stopped"] = null;

  for (const [index, statement] of statements.entries()) {
    if (options.isCancelled()) {
      stopped = "cancelled";
      break;
    }
    const started = options.now();
    const base = () => ({
      index,
      sql: statement.text.slice(0, MAX_OUTCOME_SQL_CHARS),
      durationMs: Math.round(options.now() - started),
    });
    summary.statements += 1;
    try {
      const result = await executeOne(session, statement.text, options);
      const outcome = toOutcome(base(), result, options.maxRows);
      summary.succeeded += 1;
      if (outcome.kind === "affected") summary.affected += outcome.affected;
      window.add(outcome);
    } catch (error) {
      const message = errorMessage(error);
      window.add({ ...base(), kind: "error", message, position: errorPosition(error) });
      stopped = options.isCancelled() ? "cancelled" : "error";
      break;
    }
  }

  return {
    outcomes: window.toArray(),
    omitted: window.omitted,
    summary,
    stopped,
    durationMs: Math.round(options.now() - runStart),
  };
}
