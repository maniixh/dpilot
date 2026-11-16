import {
  type ConfirmationRequired,
  type Dialect,
  explainSql,
  MAX_SCRIPT_BYTES,
  type QueryRequest,
  type QueryRun,
  type SqlStatement,
  type StatementOutcome,
  splitStatements,
  statementAt,
} from "@dpilot/shared";
import { ApiError } from "../../api/client.ts";
import type { RunResult } from "../../api/query.ts";
import { MAX_TABS } from "./tabs-model.ts";

/** The text that was sent, and where it starts in the editor, so errors map back onto the editor. */
export interface RunSource {
  sql: string;
  offset: number;
}

const MAX_MAX_ROWS = 10_000;
const KEPT_AT_EACH_END = 50;
const EDITOR_FILE_BYTES = 1024 * 1024;
const MB = 1024 * 1024;

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

export function runTarget(
  doc: string,
  selection: { from: number; to: number },
  dialect: Dialect,
  mode: "selection" | "all",
): RunSource {
  if (mode === "all") return { sql: doc, offset: 0 };
  const selected = doc.slice(selection.from, selection.to);
  if (selected.trim() !== "") return { sql: selected, offset: selection.from };
  const statement = statementAt(splitStatements(doc, dialect), selection.from);
  return statement === null
    ? { sql: "", offset: 0 }
    : { sql: statement.text, offset: statement.start };
}

/** An EXPLAIN of the statement; it no longer maps onto the editor text, so no offset. */
export function explainStatement(source: RunSource, dialect: Dialect): RunSource {
  const text = source.sql.trim();
  return { sql: text === "" ? "" : explainSql(dialect, text), offset: 0 };
}

/** The editor range of the word an error points at; null when the server gave no position. */
export function errorRange(
  statement: Pick<SqlStatement, "text" | "start">,
  outcome: StatementOutcome,
  offset = 0,
): { from: number; to: number } | null {
  if (outcome.kind !== "error" || outcome.position === null) return null;
  const { text } = statement;
  if (outcome.position > text.length) return null;
  const at = Math.min(outcome.position, Math.max(text.length - 1, 0));
  const word = /^[\w$]+/.exec(text.slice(at))?.[0].length ?? 1;
  const from = offset + statement.start + at;
  return { from, to: from + word };
}

export function outcomeTitle(outcome: StatementOutcome): string {
  const n = outcome.index + 1;
  switch (outcome.kind) {
    case "rows":
      return `Result ${n} · ${plural(outcome.rows.length, "row")}`;
    case "affected":
      return `Statement ${n} · ${plural(outcome.affected, "row")} affected`;
    case "error":
      return `Statement ${n} · Error`;
  }
}

export interface OutcomeGap {
  omitted: number;
  /** 1-based numbers of the first and last statement whose outcome was dropped. */
  from: number;
  to: number;
}

export type ResultItem =
  | { kind: "outcome"; outcome: StatementOutcome }
  | ({ kind: "gap" } & OutcomeGap);

/** The server keeps the first 50 and last 50 outcomes; this puts a marker where the rest were. */
export function windowOutcomes(run: Pick<QueryRun, "outcomes" | "omitted">): ResultItem[] {
  const items: ResultItem[] = run.outcomes.map((outcome) => ({ kind: "outcome", outcome }));
  if (run.omitted === 0) return items;
  const split = Math.min(KEPT_AT_EACH_END, run.outcomes.length);
  const lastHead = run.outcomes[split - 1];
  const firstTail = run.outcomes[split];
  const from = (lastHead?.index ?? -1) + 2;
  const to = firstTail === undefined ? from + run.omitted - 1 : firstTail.index;
  items.splice(split, 0, { kind: "gap", omitted: run.omitted, from, to });
  return items;
}

export function gapLabel(gap: OutcomeGap): string {
  const which =
    gap.from === gap.to ? `statement ${gap.from}` : `statements ${gap.from} to ${gap.to}`;
  return `${plural(gap.omitted, "result")} not shown (${which})`;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function runSummary(run: QueryRun): string {
  const { statements, succeeded, affected } = run.summary;
  const parts = [`${count(succeeded)} of ${plural(statements, "statement")} succeeded`];
  if (affected > 0) parts.push(`${plural(affected, "row")} affected`);
  if (run.stopped === "error") parts.push("stopped at an error");
  if (run.stopped === "cancelled") parts.push("cancelled");
  parts.push(formatDuration(run.durationMs));
  return parts.join(" · ");
}

export function buildRunRequest(input: QueryRequest): QueryRequest {
  return { ...input, maxRows: Math.min(Math.max(Math.trunc(input.maxRows), 1), MAX_MAX_ROWS) };
}

type SettledPhase =
  | { phase: "idle" }
  | { phase: "done"; run: QueryRun; source: RunSource }
  | { phase: "failed"; message: string };

export type RunPhase =
  | SettledPhase
  | {
      phase: "running";
      request: QueryRequest;
      source: RunSource;
      /** Cancel was pressed; the tab stays busy until the run itself comes back. */
      cancelling: boolean;
      previous: SettledPhase;
    }
  | {
      phase: "confirm";
      request: QueryRequest;
      source: RunSource;
      statements: ConfirmationRequired["statements"];
      previous: SettledPhase;
    };

function settledOf(state: RunPhase): SettledPhase {
  return state.phase === "running" || state.phase === "confirm" ? state.previous : state;
}

export const isBusy = (state: RunPhase): boolean => state.phase === "running";

export function beginRun(state: RunPhase, request: QueryRequest, source: RunSource): RunPhase {
  return { phase: "running", request, source, cancelling: false, previous: settledOf(state) };
}

export function markCancelling(state: RunPhase): RunPhase {
  return state.phase === "running" ? { ...state, cancelling: true } : state;
}

export function settleRun(state: RunPhase, result: RunResult): RunPhase {
  if (state.phase !== "running") return state;
  if (result.kind === "confirm") {
    return {
      phase: "confirm",
      request: state.request,
      source: state.source,
      statements: result.statements,
      previous: state.previous,
    };
  }
  return { phase: "done", run: result.run, source: state.source };
}

export function failRun(_state: RunPhase, error: Error): RunPhase {
  return { phase: "failed", message: describeRunError(error) };
}

export function declineConfirmation(state: RunPhase): RunPhase {
  return state.phase === "confirm" ? state.previous : state;
}

/** The same script again with `confirmed: true`, under a new run id. */
export function confirmedRequest(state: RunPhase, runId: string): QueryRequest | null {
  return state.phase === "confirm" ? { ...state.request, runId, confirmed: true } : null;
}

export function describeRunError(error: Error): string {
  if (!(error instanceof ApiError)) return "Dpilot couldn't reach its server to run this.";
  switch (error.code) {
    case "busy":
      return "This tab is still running a query. Wait for it to finish or cancel it.";
    case "run_not_found":
      return "That run has already finished.";
    default:
      return error.message;
  }
}

export type FileRunPlan =
  | { kind: "tab" }
  | { kind: "direct" }
  | { kind: "reject"; message: string };

/** Small files open in a tab so errors can be highlighted; big ones run without loading. */
export function planFileRun(size: number, tabCount: number): FileRunPlan {
  if (size === 0) return { kind: "reject", message: "That file is empty." };
  if (size > MAX_SCRIPT_BYTES) {
    return {
      kind: "reject",
      message: `That file is ${(size / MB).toFixed(1)} MB. Dpilot runs scripts of up to ${MAX_SCRIPT_BYTES / MB} MB.`,
    };
  }
  return size <= EDITOR_FILE_BYTES && tabCount < MAX_TABS ? { kind: "tab" } : { kind: "direct" };
}
