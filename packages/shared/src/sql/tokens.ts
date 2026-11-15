import type { Dialect } from "../data.ts";

export type TokenKind = "word" | "ident" | "string" | "number" | "punct" | "comment" | "space";

export interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
}

// `execDepth` > 0 while inside a MySQL executable comment (`/*! … */`), whose content runs as code.
// `delimiter` is the active MySQL client delimiter; words and numbers stop where it begins.
export interface ScanState {
  execDepth: number;
  delimiter: string;
}

export function newScanState(): ScanState {
  return { execDepth: 0, delimiter: ";" };
}

const SPACE = /[ \t\r\n\f\v\ufeff]/;
const DIGIT = /[0-9]/;
const WORD_START = /[A-Za-z_\u0080-\uffff]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-\uffff]/;
const NUMBER_PART = /[A-Za-z0-9_.]/;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;

export function isSpaceChar(char: string | undefined): boolean {
  return char !== undefined && SPACE.test(char);
}

// MySQL starts a `--` comment only when whitespace, a control character or the end follows.
function endsDashes(text: string, i: number): boolean {
  return i >= text.length || isSpaceChar(text[i]) || text.charCodeAt(i) < 0x20;
}

function make(kind: TokenKind, text: string, start: number, end: number): Token {
  return { kind, text: text.slice(start, end), start, end };
}

function endOfQuoted(text: string, start: number, quote: string, backslash: boolean): number {
  let i = start + 1;
  while (i < text.length) {
    const char = text[i];
    if (backslash && char === "\\") {
      i += 2;
    } else if (char === quote) {
      if (text[i + 1] !== quote) return i + 1;
      i += 2;
    } else {
      i += 1;
    }
  }
  return text.length;
}

function endOfLine(text: string, start: number): number {
  const newline = text.indexOf("\n", start);
  return newline === -1 ? text.length : newline;
}

function endOfNestedComment(text: string, start: number): number {
  let depth = 1;
  let i = start + 2;
  while (i < text.length) {
    if (text.startsWith("/*", i)) {
      depth += 1;
      i += 2;
    } else if (text.startsWith("*/", i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
    } else {
      i += 1;
    }
  }
  return text.length;
}

function endOfBlockComment(text: string, start: number): number {
  const close = text.indexOf("*/", start + 2);
  return close === -1 ? text.length : close + 2;
}

function scanBlockComment(text: string, i: number, dialect: Dialect, state: ScanState): Token {
  if (dialect === "postgres") return make("comment", text, i, endOfNestedComment(text, i));
  const marker = /\/\*(?:M?!)(?:\d{5,6})?/y;
  marker.lastIndex = i;
  const executable = marker.exec(text);
  if (executable) {
    state.execDepth += 1;
    return make("space", text, i, marker.lastIndex);
  }
  if (state.execDepth > 0) {
    // Anything that nests inside executable code stays visible as code.
    state.execDepth += 1;
    return make("space", text, i, i + 2);
  }
  return make("comment", text, i, endOfBlockComment(text, i));
}

function atDelimiter(text: string, i: number, state: ScanState): boolean {
  return state.delimiter !== ";" && text.startsWith(state.delimiter, i);
}

function scanWord(text: string, i: number, state: ScanState): number {
  let j = i + 1;
  while (j < text.length && WORD_PART.test(text[j] ?? "") && !atDelimiter(text, j, state)) j += 1;
  return j;
}

function scanNumber(text: string, i: number, state: ScanState): number {
  let j = i + 1;
  while (j < text.length && NUMBER_PART.test(text[j] ?? "") && !atDelimiter(text, j, state)) j += 1;
  return j;
}

function scanDollar(text: string, i: number): Token | null {
  DOLLAR_TAG.lastIndex = i;
  const open = DOLLAR_TAG.exec(text);
  if (open) {
    const tag = open[0];
    const close = text.indexOf(tag, i + tag.length);
    return make("string", text, i, close === -1 ? text.length : close + tag.length);
  }
  if (DIGIT.test(text[i + 1] ?? "")) {
    let j = i + 1;
    while (DIGIT.test(text[j] ?? "")) j += 1;
    return make("number", text, i, j);
  }
  return null;
}

function scanQuoted(text: string, i: number, dialect: Dialect): Token | null {
  const char = text[i];
  const mysql = dialect === "mysql";
  if (char === "'") return make("string", text, i, endOfQuoted(text, i, "'", mysql));
  if (char === '"') {
    return make(mysql ? "string" : "ident", text, i, endOfQuoted(text, i, '"', mysql));
  }
  if (char === "`" && mysql) return make("ident", text, i, endOfQuoted(text, i, "`", false));
  return null;
}

export function scanToken(text: string, i: number, dialect: Dialect, state: ScanState): Token {
  const char = text[i] ?? "";
  const mysql = dialect === "mysql";

  if (isSpaceChar(char)) {
    let j = i + 1;
    while (isSpaceChar(text[j])) j += 1;
    return make("space", text, i, j);
  }
  if (char === "-" && text.startsWith("--", i) && (!mysql || endsDashes(text, i + 2))) {
    return make("comment", text, i, endOfLine(text, i));
  }
  if (char === "#" && mysql) return make("comment", text, i, endOfLine(text, i));
  if (char === "/" && text[i + 1] === "*") return scanBlockComment(text, i, dialect, state);
  if (char === "*" && text[i + 1] === "/" && state.execDepth > 0) {
    state.execDepth -= 1;
    return make("space", text, i, i + 2);
  }

  const quoted = scanQuoted(text, i, dialect);
  if (quoted) return quoted;
  if (!mysql && (char === "e" || char === "E") && text[i + 1] === "'") {
    return make("string", text, i, endOfQuoted(text, i + 1, "'", true));
  }
  if (!mysql && char === "$") {
    const dollar = scanDollar(text, i);
    if (dollar) return dollar;
  }
  if (DIGIT.test(char)) return make("number", text, i, scanNumber(text, i, state));
  if (WORD_START.test(char) || (mysql && char === "$")) {
    return make("word", text, i, scanWord(text, i, state));
  }
  return make("punct", text, i, i + 1);
}

export function tokenize(text: string, dialect: Dialect): Token[] {
  const state = newScanState();
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const token = scanToken(text, i, dialect, state);
    tokens.push(token);
    i = token.end;
  }
  return tokens;
}
