import type { Dialect } from "../data.ts";
import { newScanState, scanToken } from "./tokens.ts";

export interface SqlStatement {
  text: string;
  start: number;
  end: number;
}

const DELIMITER_LINE = /delimiter[ \t]+(\S+)[^\n]*/iy;

function trimmed(text: string, start: number, end: number): SqlStatement | null {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(text[from] ?? "")) from += 1;
  while (to > from && /\s/.test(text[to - 1] ?? "")) to -= 1;
  return from === to ? null : { text: text.slice(from, to), start: from, end: to };
}

export function splitStatements(text: string, dialect: Dialect): SqlStatement[] {
  const statements: SqlStatement[] = [];
  const state = newScanState();
  let pos = 0;
  let start = 0;
  let hasCode = false;

  const finish = (end: number) => {
    const statement = hasCode ? trimmed(text, start, end) : null;
    if (statement) statements.push(statement);
    hasCode = false;
  };

  while (pos < text.length) {
    if (dialect === "mysql" && !hasCode && state.execDepth === 0) {
      DELIMITER_LINE.lastIndex = pos;
      const line = DELIMITER_LINE.exec(text);
      if (line?.[1]) {
        state.delimiter = line[1];
        pos = DELIMITER_LINE.lastIndex;
        start = pos;
        continue;
      }
    }
    // The client does not split inside an executable comment, so neither do we.
    if (state.execDepth === 0 && text.startsWith(state.delimiter, pos)) {
      finish(pos);
      pos += state.delimiter.length;
      start = pos;
      continue;
    }
    const token = scanToken(text, pos, dialect, state);
    if (token.kind !== "space" && token.kind !== "comment") hasCode = true;
    pos = token.end;
  }
  finish(text.length);
  return statements;
}

export function statementAt<T extends { start: number; end: number }>(
  statements: readonly T[],
  offset: number,
): T | null {
  const containing = statements.find((s) => s.start <= offset && offset <= s.end);
  if (containing) return containing;
  let before: T | null = null;
  for (const statement of statements) if (statement.end <= offset) before = statement;
  return before;
}
