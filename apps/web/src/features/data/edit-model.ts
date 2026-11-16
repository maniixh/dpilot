import type {
  CellValue,
  ColumnMeta,
  EditValue,
  InsertRequest,
  RowKey,
  TableMeta,
  TableRef,
  UpdateRequest,
} from "@dpilot/shared";
import type { FormattedCell } from "./grid-model.ts";

/** What the user has typed into a cell or form field; NULL and DEFAULT are modes, not text. */
export type CellDraft = { mode: "value"; text: string } | { mode: "null" } | { mode: "default" };

export interface PendingRow {
  key: RowKey;
  values: Record<string, EditValue>;
  error: string | null;
}

/** Keyed by `rowId(key)`. Maps are treated as immutable: every change returns a new one. */
export type PendingEdits = Map<string, PendingRow>;

/** A stable id for a row: the key's columns in name order, values kept as exact text. */
export function rowId(key: RowKey): string {
  return JSON.stringify(Object.entries(key).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Generated columns are computed and binary columns change only through the cell upload. */
export function isEditableColumn(column: ColumnMeta): boolean {
  return !column.generated && column.kind !== "binary";
}

export function draftOf(value: CellValue): CellDraft {
  if (value === null) return { mode: "null" };
  if (typeof value === "object") return { mode: "value", text: "" };
  return { mode: "value", text: String(value) };
}

const INTEGER = /^[+-]?\d+$/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const BOOLEAN = /^(true|false|t|f|0|1)$/i;

const orNull = (message: string, nullable: boolean) =>
  nullable ? `${message.slice(0, -1)}, or use NULL.` : message;

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Turns typed text into the request value, or the sentence to show the user. */
export function parseDraft(draft: CellDraft, column: ColumnMeta): EditValue | string {
  if (draft.mode === "default") return { useDefault: true };
  if (draft.mode === "null") {
    return column.nullable ? { set: null } : "This column doesn't allow NULL.";
  }
  const { text } = draft;
  const trimmed = text.trim();
  switch (column.kind) {
    case "binary":
      return "Binary columns change only through upload.";
    case "text":
      return { set: text };
    case "integer":
      if (trimmed === "") return orNull("Enter a whole number.", column.nullable);
      return INTEGER.test(trimmed)
        ? { set: trimmed }
        : orNull("Enter a whole number.", column.nullable);
    case "decimal":
    case "float":
      if (trimmed === "") return orNull("Enter a number.", column.nullable);
      return NUMBER.test(trimmed) ? { set: trimmed } : orNull("Enter a number.", column.nullable);
    case "boolean":
      return BOOLEAN.test(trimmed) ? { set: trimmed } : "Enter true or false.";
    case "json":
      return isJson(text) ? { set: text } : "Enter valid JSON.";
    case "date":
    case "datetime":
    case "time":
    case "other":
      return trimmed === "" ? orNull("Enter a value.", column.nullable) : { set: trimmed };
  }
}

function sameAsOriginal(value: EditValue, original: CellValue): boolean {
  if ("useDefault" in value) return false;
  if (value.set === null) return original === null;
  return original !== null && typeof original !== "object" && String(original) === value.set;
}

/** Records an edit; setting a cell back to what the server sent removes it. */
export function setCell(
  edits: PendingEdits,
  key: RowKey,
  column: string,
  value: EditValue,
  original: CellValue,
): PendingEdits {
  const id = rowId(key);
  const values = { ...edits.get(id)?.values };
  if (sameAsOriginal(value, original)) delete values[column];
  else values[column] = value;
  const next = new Map(edits);
  if (Object.keys(values).length === 0) next.delete(id);
  else next.set(id, { key, values, error: null });
  return next;
}

export function failRow(edits: PendingEdits, key: RowKey, error: string): PendingEdits {
  const id = rowId(key);
  const row = edits.get(id);
  return row === undefined ? edits : new Map(edits).set(id, { ...row, error });
}

/** Drops one row's edits, or all of them. */
export function discard(edits: PendingEdits, key?: RowKey): PendingEdits {
  if (key === undefined) return new Map();
  const next = new Map(edits);
  next.delete(rowId(key));
  return next;
}

export function countChanges(edits: PendingEdits): number {
  let count = 0;
  for (const row of edits.values()) count += Object.keys(row.values).length;
  return count;
}

export function describeKey(key: RowKey): string {
  return Object.entries(key)
    .map(([name, value]) => `${name} = ${value}`)
    .join(", ");
}

/** One update per row, using each row's key exactly as the server sent it. */
export function toUpdates(edits: PendingEdits, ref: TableRef): UpdateRequest[] {
  return [...edits.values()].map(({ key, values }) => ({ ref, key, values }));
}

/** How a pending value reads in its cell. */
export function describeEdit(value: EditValue): FormattedCell {
  if ("useDefault" in value) return { text: "DEFAULT", muted: true };
  return value.set === null ? { text: "NULL", muted: true } : { text: value.set, muted: false };
}

/** Starting values for the add-row form. */
export function insertDraft(meta: TableMeta): Record<string, EditValue> {
  return Object.fromEntries(
    meta.columns.map((column): [string, EditValue] => {
      const usesDefault =
        column.autoIncrement ||
        column.generated ||
        column.kind === "binary" ||
        column.defaultValue !== null;
      if (usesDefault) return [column.name, { useDefault: true }];
      return [column.name, { set: column.nullable ? null : "" }];
    }),
  );
}

export function toCellDraft(value: EditValue): CellDraft {
  if ("useDefault" in value) return { mode: "default" };
  return value.set === null ? { mode: "null" } : { mode: "value", text: value.set };
}

/** The insert request, or each invalid field's message. Non-editable columns are left out. */
export function buildInsert(
  meta: TableMeta,
  ref: TableRef,
  drafts: Record<string, CellDraft>,
): InsertRequest | { errors: Record<string, string> } {
  const values: Record<string, EditValue> = {};
  const errors: Record<string, string> = {};
  for (const column of meta.columns.filter(isEditableColumn)) {
    const parsed = parseDraft(drafts[column.name] ?? { mode: "default" }, column);
    if (typeof parsed === "string") errors[column.name] = parsed;
    else values[column.name] = parsed;
  }
  return Object.keys(errors).length > 0 ? { errors } : { ref, values };
}

export const MAX_CELL_BYTES = 16 * 1024 * 1024;

export interface EditFailure {
  status: number | null;
  code: string | null;
  message: string;
}

/** The sentence for a failed edit, insert, delete or upload. */
export function describeEditError({ status, code, message }: EditFailure): string {
  if (status === 413) return "That file is over the 16 MB limit for a cell.";
  switch (code) {
    case "row_not_found":
      return "This row no longer exists. Reload the table to see what changed.";
    case "key_not_unique":
      return "More than one row has this key, so nothing was changed.";
    case "not_editable":
      return `This table can't be edited. ${message}`;
    case "read_only":
      return "This connection is read-only.";
    default:
      return message;
  }
}
