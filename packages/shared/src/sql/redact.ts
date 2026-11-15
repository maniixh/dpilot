import type { Dialect } from "../data.ts";
import { type Token, tokenize } from "./tokens.ts";

type Span = readonly [start: number, end: number];

const DIALECTS: readonly Dialect[] = ["mysql", "postgres"];
const MASK = "'***'";

function upperAt(tokens: Token[], i: number): string {
  const token = tokens[i];
  return token?.kind === "word" ? token.text.toUpperCase() : "";
}

function isPunct(token: Token | undefined, text: string): boolean {
  return token?.kind === "punct" && token.text === text;
}

function stringSpan(tokens: Token[], i: number): Span[] {
  const token = tokens[i];
  return token?.kind === "string" ? [[token.start, token.end]] : [];
}

function afterIdentified(tokens: Token[], at: number): Span[] {
  let i = at + 1;
  if (upperAt(tokens, i) === "WITH") i += 2;
  if (upperAt(tokens, i) !== "BY" && upperAt(tokens, i) !== "AS") return [];
  i += 1;
  if (upperAt(tokens, i) === "PASSWORD") i += 1;
  const spans = stringSpan(tokens, i);
  if (spans.length > 0 && upperAt(tokens, i + 1) === "REPLACE") {
    spans.push(...stringSpan(tokens, i + 2));
  }
  return spans;
}

function afterPassword(tokens: Token[], at: number): Span[] {
  let i = at + 1;
  if (upperAt(tokens, i) === "FOR") {
    while (i < tokens.length && !isPunct(tokens[i], "=")) i += 1;
  }
  while (isPunct(tokens[i], "=") || isPunct(tokens[i], "(") || upperAt(tokens, i) === "PASSWORD") {
    i += 1;
  }
  return stringSpan(tokens, i);
}

function secretSpans(text: string, dialect: Dialect): Span[] {
  const tokens = tokenize(text, dialect).filter(
    (token) => token.kind !== "space" && token.kind !== "comment",
  );
  return tokens.flatMap((_, i) => {
    const word = upperAt(tokens, i);
    if (word === "IDENTIFIED") return afterIdentified(tokens, i);
    if (word === "PASSWORD" || word.endsWith("_PASSWORD")) return afterPassword(tokens, i);
    return [];
  });
}

// MySQL and Postgres disagree on where a string ends (`\'`), so mask what either one sees.
export function redactSql(text: string): string {
  const spans = DIALECTS.flatMap((dialect) => secretSpans(text, dialect)).sort(
    (a, b) => a[0] - b[0],
  );
  const merged: [number, number][] = [];
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1];
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let result = text;
  for (const [start, end] of merged.reverse()) {
    result = result.slice(0, start) + MASK + result.slice(end);
  }
  return result;
}
