import type { Dialect } from "../data.ts";
import { type Token, tokenize } from "./tokens.ts";

export type StatementClass = "read" | "write" | "ddl" | "transaction" | "session" | "unknown";

// `upper` is the upper-cased text of words and empty for every other token kind, so quoted
// identifiers, strings and numbers can never be mistaken for keywords.
interface Sig {
  kind: Token["kind"];
  text: string;
  upper: string;
}

const READ_STARTS = new Set([
  "SELECT",
  "WITH",
  "VALUES",
  "TABLE",
  "SHOW",
  "DESCRIBE",
  "DESC",
  "EXPLAIN",
]);
const EXPLAIN_STARTS = new Set(["EXPLAIN", "DESCRIBE", "DESC"]);
const DML = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE"]);
const UNPLACED_IN_READ = new Set(["INTO", "CALL", "DO", "COPY", "LOCK"]);
const LOCKING_AFTER_FOR = new Set(["UPDATE", "SHARE", "KEY", "NO"]);
const DDL_STARTS = new Set([
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "RENAME",
  "COMMENT",
  "GRANT",
  "REVOKE",
]);
const TRANSACTION_STARTS = new Set([
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "END",
  "ABORT",
]);
const SESSION_STARTS = new Set(["SET", "USE", "RESET", "DISCARD", "DEALLOCATE"]);
// Statements that only define something, so DELETE/UPDATE words inside them are not actions.
const DEFINITIONS = new Set(["CREATE", "ALTER", "GRANT", "REVOKE", "COMMENT"]);
// Words that make a following DELETE/UPDATE part of another clause (ON DELETE CASCADE,
// FOR UPDATE, ON CONFLICT DO UPDATE, MERGE … THEN DELETE, trigger events, …).
const CLAUSE_PREFIX = new Set(["ON", "FOR", "KEY", "DO", "OF", "OR", "BEFORE", "AFTER", "THEN"]);
const RISKY_WORDS = new Set(["DELETE", "UPDATE", "DROP", "TRUNCATE"]);
const RISKY_IN_STRING = /\b(?:delete|update|drop|truncate)\b/i;

const MESSAGES = {
  truncate: "Empties the table (TRUNCATE)",
  alterDrop: "Drops part of a table (ALTER … DROP)",
  deleteAll: "DELETE without WHERE affects every row",
  updateAll: "UPDATE without WHERE affects every row",
  unsure: "Can't tell what this statement changes",
} as const;

function significantGroups(text: string, dialect: Dialect): Sig[][] {
  const groups: Sig[][] = [[]];
  for (const token of tokenize(text, dialect)) {
    if (token.kind === "space" || token.kind === "comment") continue;
    if (token.kind === "punct" && token.text === ";") {
      groups.push([]);
      continue;
    }
    const upper = token.kind === "word" ? token.text.toUpperCase() : "";
    groups[groups.length - 1]?.push({ kind: token.kind, text: token.text, upper });
  }
  return groups.filter((group) => group.length > 0);
}

function isOpen(sig: Sig | undefined): boolean {
  return sig?.kind === "punct" && sig.text === "(";
}

function firstWordIndex(group: Sig[]): number {
  let i = 0;
  while (isOpen(group[i])) i += 1;
  return i;
}

function isFunctionCall(group: Sig[], i: number, dialect: Dialect): boolean {
  const word = group[i]?.upper;
  const callable = word === "REPLACE" || (word === "INSERT" && dialect === "mysql");
  return callable && isOpen(group[i + 1]);
}

function classifyRead(group: Sig[], first: string, dialect: Dialect): StatementClass {
  const analyzes = group.some((sig) => sig.upper === "ANALYZE" || sig.upper === "ANALYSE");
  if (EXPLAIN_STARTS.has(first) && analyzes) return "unknown";
  if (group.some((sig, i) => DML.has(sig.upper) && !isFunctionCall(group, i, dialect))) {
    return "write";
  }
  const locks = group.some(
    (sig, i) => sig.upper === "FOR" && LOCKING_AFTER_FOR.has(group[i + 1]?.upper ?? ""),
  );
  if (locks || group.some((sig) => UNPLACED_IN_READ.has(sig.upper))) return "unknown";
  return "read";
}

function classifyGroup(group: Sig[], dialect: Dialect): StatementClass {
  const at = firstWordIndex(group);
  const first = group[at]?.upper ?? "";
  if (READ_STARTS.has(first)) return classifyRead(group, first, dialect);
  if (DML.has(first)) return "write";
  if (DDL_STARTS.has(first)) return "ddl";
  if (SESSION_STARTS.has(first)) return "session";
  if (first === "START") return group[at + 1]?.upper === "TRANSACTION" ? "transaction" : "unknown";
  if (TRANSACTION_STARTS.has(first)) return "transaction";
  return "unknown";
}

export function classifyStatement(text: string, dialect: Dialect): StatementClass {
  const groups = significantGroups(text, dialect);
  const [only] = groups;
  return groups.length === 1 && only ? classifyGroup(only, dialect) : "unknown";
}

function nestingDepths(group: Sig[]): number[] {
  let depth = 0;
  return group.map((sig) => {
    if (sig.kind === "punct" && sig.text === ")") depth = Math.max(0, depth - 1);
    const at = depth;
    if (isOpen(sig)) depth += 1;
    return at;
  });
}

function hasOwnWhere(group: Sig[], depths: number[], from: number): boolean {
  const level = depths[from] ?? 0;
  for (let i = from + 1; i < group.length; i += 1) {
    const depth = depths[i] ?? 0;
    if (depth < level) return false;
    if (depth === level && group[i]?.upper === "WHERE") return true;
  }
  return false;
}

function dropReason(group: Sig[], dropAt: number): string {
  let i = dropAt + 1;
  while (group[i]?.upper === "TEMPORARY" || group[i]?.upper === "TEMP") i += 1;
  const kind = group[i]?.upper;
  if (!kind) return "Drops object";
  const next = group[i + 1]?.upper;
  const compound =
    (kind === "MATERIALIZED" && next === "VIEW") ||
    (kind === "FOREIGN" && (next === "TABLE" || next === "DATA"));
  if (!compound) return `Drops ${kind.toLowerCase()}`;
  const wrapper = kind === "FOREIGN" && next === "DATA" ? " wrapper" : "";
  return `Drops ${kind.toLowerCase()} ${next?.toLowerCase()}${wrapper}`;
}

function rowsWithoutWhere(group: Sig[]): string[] {
  const depths = nestingDepths(group);
  const reasons: string[] = [];
  group.forEach((sig, i) => {
    if (sig.upper !== "DELETE" && sig.upper !== "UPDATE") return;
    if (CLAUSE_PREFIX.has(group[i - 1]?.upper ?? "")) return;
    if (hasOwnWhere(group, depths, i)) return;
    reasons.push(sig.upper === "DELETE" ? MESSAGES.deleteAll : MESSAGES.updateAll);
  });
  return reasons;
}

function mentionsRiskyWork(group: Sig[]): boolean {
  return group.some(
    (sig) =>
      RISKY_WORDS.has(sig.upper) || (sig.kind === "string" && RISKY_IN_STRING.test(sig.text)),
  );
}

function groupReasons(group: Sig[], dialect: Dialect): string[] {
  const at = firstWordIndex(group);
  const first = group[at]?.upper ?? "";
  const reasons: string[] = [];
  if (first === "DROP") reasons.push(dropReason(group, at));
  if (first === "TRUNCATE") reasons.push(MESSAGES.truncate);
  if (first === "ALTER" && group.some((sig) => sig.upper === "DROP")) {
    reasons.push(MESSAGES.alterDrop);
  }
  if (!DEFINITIONS.has(first)) reasons.push(...rowsWithoutWhere(group));
  if (reasons.length === 0 && classifyGroup(group, dialect) === "unknown") {
    if (mentionsRiskyWork(group)) reasons.push(MESSAGES.unsure);
  }
  return reasons;
}

export function destructiveReasons(text: string, dialect: Dialect): string[] {
  const reasons = significantGroups(text, dialect).flatMap((group) => groupReasons(group, dialect));
  return [...new Set(reasons)];
}

export function explainSql(dialect: Dialect, text: string): string {
  return dialect === "mysql" ? `EXPLAIN ${text}` : `EXPLAIN (FORMAT TEXT) ${text}`;
}
