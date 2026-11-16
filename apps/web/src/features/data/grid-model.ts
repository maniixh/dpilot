import type { AggregateFn, CellValue, ColumnKind, Filter, Sort } from "@dpilot/shared";

export interface FormattedCell {
  text: string;
  muted: boolean;
}

const UNITS = ["B", "KB", "MB", "GB"] as const;

function formatSize(size: number): string {
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`;
}

const HEX_PREVIEW_CHARS = 8;

/** Values are shown exactly as the server sent them; only NULL and bytes get a summary. */
export function formatCell(value: CellValue, _kind: ColumnKind): FormattedCell {
  if (value === null) return { text: "NULL", muted: true };
  if (typeof value === "object") {
    const { size, hex } = value.bytes;
    if (size === 0) return { text: formatSize(0), muted: true };
    const preview = hex.slice(0, HEX_PREVIEW_CHARS);
    const more = size * 2 > preview.length ? "…" : "";
    return { text: `${formatSize(size)} · ${preview}${more}`, muted: true };
  }
  return { text: String(value), muted: false };
}

const MAX_SORT_COLUMNS = 5;

/** Click cycles a column ascending, descending, off; `additive` (shift-click) keeps the others. */
export function toggleSort(sort: readonly Sort[], column: string, additive: boolean): Sort[] {
  const current = sort.find((s) => s.column === column);
  const next: Sort | null =
    current === undefined
      ? { column, direction: "asc" }
      : current.direction === "asc"
        ? { column, direction: "desc" }
        : null;

  if (!additive) return next === null ? [] : [next];
  if (current === undefined) {
    return sort.length >= MAX_SORT_COLUMNS || next === null ? [...sort] : [...sort, next];
  }
  return sort.flatMap((s) => (s.column !== column ? [s] : next === null ? [] : [next]));
}

const number = new Intl.NumberFormat("en-US");

/** `count` is null until the total arrives. */
export function pageLabel(offset: number, count: number | null, rows: number): string {
  if (count === 0) return "No rows";
  if (rows === 0) return count === null ? "No rows" : "No rows on this page";
  const range = `${number.format(offset + 1)}–${number.format(offset + rows)}`;
  return count === null ? range : `${range} of ${number.format(count)}`;
}

type FilterOp = Filter["op"];

const NULL_OPS: FilterOp[] = ["is_null", "not_null"];
const EQUALITY_OPS: FilterOp[] = ["eq", "ne"];
const ORDER_OPS: FilterOp[] = ["lt", "le", "gt", "ge", "in", "not_in"];
const PATTERN_OPS: FilterOp[] = ["like", "not_like"];

export function filterOps(kind: ColumnKind): FilterOp[] {
  switch (kind) {
    case "binary":
      return NULL_OPS;
    case "boolean":
      return [...EQUALITY_OPS, ...NULL_OPS];
    case "integer":
    case "decimal":
    case "float":
    case "date":
    case "datetime":
    case "time":
      return [...EQUALITY_OPS, ...ORDER_OPS, ...NULL_OPS];
    case "json":
    case "other":
      return [...EQUALITY_OPS, ...PATTERN_OPS, ...NULL_OPS];
    case "text":
      return [...EQUALITY_OPS, ...ORDER_OPS, ...PATTERN_OPS, ...NULL_OPS];
  }
}

const OP_LABELS: Record<FilterOp, string> = {
  eq: "is",
  ne: "is not",
  lt: "<",
  le: "≤",
  gt: ">",
  ge: "≥",
  like: "like",
  not_like: "not like",
  in: "in",
  not_in: "not in",
  is_null: "is NULL",
  not_null: "is not NULL",
};

export const opLabel = (op: FilterOp): string => OP_LABELS[op];

export const opTakesValue = (op: FilterOp): boolean => !NULL_OPS.includes(op);

const NUMERIC_KINDS: ColumnKind[] = ["integer", "decimal", "float"];

export const isNumericKind = (kind: ColumnKind): boolean => NUMERIC_KINDS.includes(kind);

/** Sum and average only make sense on numbers; documents and bytes have no useful order. */
export function aggregateFns(kind: ColumnKind): AggregateFn[] {
  if (kind === "json" || kind === "binary") return ["count"];
  return isNumericKind(kind) ? ["count", "sum", "avg", "min", "max"] : ["count", "min", "max"];
}

export interface FilterDraft {
  column: string;
  op: FilterOp;
  value: string;
}

const MAX_LIST_VALUES = 100;

/** Turns a filter row's text fields into a request filter, or the sentence to show the user. */
export function parseFilterDraft(draft: FilterDraft): Filter | string {
  const { column, op, value } = draft;
  if (column === "") return "Pick a column.";
  switch (op) {
    case "is_null":
    case "not_null":
      return { op, column };
    case "in":
    case "not_in": {
      const values = value
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v !== "");
      if (values.length === 0) return "Enter at least one value, separated by commas.";
      if (values.length > MAX_LIST_VALUES) return `Use at most ${MAX_LIST_VALUES} values.`;
      return { op, column, values };
    }
    case "eq":
    case "ne":
      return { op, column, value };
    default:
      return value === "" ? "Enter a value." : { op, column, value };
  }
}
