import { describe, expect, test } from "bun:test";
import type { ColumnMeta, RowKey, TableMeta } from "@dpilot/shared";
import {
  buildInsert,
  type CellDraft,
  countChanges,
  describeEdit,
  describeEditError,
  discard,
  draftOf,
  failRow,
  insertDraft,
  isEditableColumn,
  type PendingEdits,
  parseDraft,
  rowId,
  setCell,
  toUpdates,
} from "./edit-model.ts";

function column(patch: Partial<ColumnMeta> & Pick<ColumnMeta, "name">): ColumnMeta {
  return {
    type: "varchar(20)",
    kind: "text",
    nullable: false,
    defaultValue: null,
    generated: false,
    autoIncrement: false,
    ...patch,
  };
}

const value = (text: string): CellDraft => ({ mode: "value", text });
const ref = { schema: null, table: "t" };
const key: RowKey = { id: "9007199254740993" };

describe("rowId", () => {
  test("does not depend on the order of the key's columns", () => {
    expect(rowId({ a: "1", b: "2" })).toBe(rowId({ b: "2", a: "1" }));
  });
  test("keeps 64-bit keys exact", () => {
    expect(rowId({ id: "9007199254740993" })).not.toBe(rowId({ id: "9007199254740992" }));
  });
});

describe("isEditableColumn", () => {
  test("generated and binary columns are not", () => {
    expect(isEditableColumn(column({ name: "a", generated: true }))).toBe(false);
    expect(isEditableColumn(column({ name: "a", kind: "binary" }))).toBe(false);
    expect(isEditableColumn(column({ name: "a" }))).toBe(true);
    expect(isEditableColumn(column({ name: "a", autoIncrement: true, kind: "integer" }))).toBe(
      true,
    );
  });
});

describe("parseDraft", () => {
  test("an empty text value is an empty string, not NULL", () => {
    expect(parseDraft(value(""), column({ name: "a", nullable: true }))).toEqual({ set: "" });
  });
  test("the NULL mode is NULL only when the column allows it", () => {
    expect(parseDraft({ mode: "null" }, column({ name: "a", nullable: true }))).toEqual({
      set: null,
    });
    expect(parseDraft({ mode: "null" }, column({ name: "a" }))).toBe(
      "This column doesn't allow NULL.",
    );
  });
  test("the string NULL typed into a text column is kept as text", () => {
    expect(parseDraft(value("NULL"), column({ name: "a", nullable: true }))).toEqual({
      set: "NULL",
    });
  });
  test("text keeps whitespace exactly", () => {
    expect(parseDraft(value("  a "), column({ name: "a" }))).toEqual({ set: "  a " });
  });
  test("default mode sends useDefault", () => {
    expect(parseDraft({ mode: "default" }, column({ name: "a" }))).toEqual({ useDefault: true });
  });
  test("integers must be whole numbers and keep every digit", () => {
    const id = column({ name: "id", kind: "integer" });
    expect(parseDraft(value(" 9007199254740993 "), id)).toEqual({ set: "9007199254740993" });
    expect(parseDraft(value("1.5"), id)).toBe("Enter a whole number.");
    expect(parseDraft(value("abc"), id)).toBe("Enter a whole number.");
  });
  test("decimals accept signs, fractions and exponents", () => {
    const price = column({ name: "p", kind: "decimal", nullable: true });
    expect(parseDraft(value("-12.50"), price)).toEqual({ set: "-12.50" });
    expect(parseDraft(value("1e3"), price)).toEqual({ set: "1e3" });
    expect(parseDraft(value("12,5"), price)).toBe("Enter a number, or use NULL.");
  });
  test("an empty number is refused rather than sent as an empty string", () => {
    expect(parseDraft(value(""), column({ name: "n", kind: "float" }))).toBe("Enter a number.");
  });
  test("booleans accept true, false, 1 and 0", () => {
    const flag = column({ name: "f", kind: "boolean" });
    expect(parseDraft(value("TRUE"), flag)).toEqual({ set: "TRUE" });
    expect(parseDraft(value("maybe"), flag)).toBe("Enter true or false.");
  });
  test("json must parse", () => {
    const doc = column({ name: "j", kind: "json" });
    expect(parseDraft(value('{"a":1}'), doc)).toEqual({ set: '{"a":1}' });
    expect(parseDraft(value("{a"), doc)).toBe("Enter valid JSON.");
  });
  test("dates and times need a value but are checked by the database", () => {
    const when = column({ name: "d", kind: "datetime", nullable: true });
    expect(parseDraft(value("2026-01-02 03:04:05.123456"), when)).toEqual({
      set: "2026-01-02 03:04:05.123456",
    });
    expect(parseDraft(value(" "), when)).toBe("Enter a value, or use NULL.");
  });
  test("binary columns are never written as text", () => {
    expect(parseDraft(value("ab"), column({ name: "b", kind: "binary" }))).toBe(
      "Binary columns change only through upload.",
    );
  });
});

describe("draftOf", () => {
  test("NULL becomes the NULL mode and everything else its text", () => {
    expect(draftOf(null)).toEqual({ mode: "null" });
    expect(draftOf("")).toEqual(value(""));
    expect(draftOf(42)).toEqual(value("42"));
    expect(draftOf(true)).toEqual(value("true"));
    expect(draftOf({ bytes: { size: 1, hex: "00", truncated: false } })).toEqual(value(""));
  });
});

describe("setCell", () => {
  test("setCell back to the original value removes the edit", () => {
    const first = setCell(new Map(), key, "name", { set: "new" }, "old");
    expect(first.size).toBe(1);
    expect(setCell(first, key, "name", { set: "old" }, "old").size).toBe(0);
  });
  test("setting NULL back on a NULL cell removes the edit", () => {
    expect(setCell(new Map(), key, "n", { set: null }, null).size).toBe(0);
  });
  test("a number cell edited to its own text is unchanged", () => {
    expect(setCell(new Map(), key, "n", { set: "5" }, 5).size).toBe(0);
  });
  test("use default is always a change", () => {
    expect(setCell(new Map(), key, "n", { useDefault: true }, null).size).toBe(1);
  });
  test("keeps the other columns of the row and clears its error", () => {
    let edits: PendingEdits = setCell(new Map(), key, "a", { set: "1" }, "0");
    edits = failRow(edits, key, "boom");
    expect(edits.get(rowId(key))?.error).toBe("boom");
    edits = setCell(edits, key, "b", { set: "2" }, "0");
    expect(edits.get(rowId(key))).toEqual({
      key,
      values: { a: { set: "1" }, b: { set: "2" } },
      error: null,
    });
  });
  test("does not change the map it was given", () => {
    const before: PendingEdits = new Map();
    setCell(before, key, "a", { set: "1" }, "0");
    expect(before.size).toBe(0);
  });
});

describe("discard", () => {
  test("drops one row or all", () => {
    const other: RowKey = { id: "2" };
    const edits = setCell(
      setCell(new Map(), key, "a", { set: "1" }, "0"),
      other,
      "a",
      { set: "1" },
      "0",
    );
    expect([...discard(edits, key).keys()]).toEqual([rowId(other)]);
    expect(discard(edits).size).toBe(0);
  });
});

describe("toUpdates", () => {
  test("counts every changed cell across rows", () => {
    let edits: PendingEdits = setCell(new Map(), key, "a", { set: "1" }, "0");
    edits = setCell(edits, key, "b", { set: "1" }, "0");
    edits = setCell(edits, { id: "2" }, "a", { set: "1" }, "0");
    expect(countChanges(edits)).toBe(3);
  });
  test("toUpdates groups by row", () => {
    const other: RowKey = { id: "2" };
    let edits: PendingEdits = new Map();
    edits = setCell(edits, key, "a", { set: "1" }, "0");
    edits = setCell(edits, other, "a", { set: null }, "0");
    edits = setCell(edits, key, "b", { useDefault: true }, "0");
    expect(toUpdates(edits, ref)).toEqual([
      { ref, key, values: { a: { set: "1" }, b: { useDefault: true } } },
      { ref, key: other, values: { a: { set: null } } },
    ]);
  });
  test("sends the key exactly as the server gave it", () => {
    const edits = setCell(new Map(), key, "a", { set: "1" }, "0");
    expect(toUpdates(edits, ref)[0]?.key).toEqual({ id: "9007199254740993" });
  });
});

const meta: TableMeta = {
  kind: "table",
  primaryKey: ["id"],
  editable: true,
  readOnlyReason: null,
  columns: [
    column({ name: "id", kind: "integer", autoIncrement: true }),
    column({ name: "name" }),
    column({ name: "note", nullable: true }),
    column({ name: "made", kind: "datetime", defaultValue: "CURRENT_TIMESTAMP" }),
    column({ name: "total", kind: "integer", generated: true }),
    column({ name: "photo", kind: "binary", nullable: true }),
  ],
};

describe("insertDraft", () => {
  test("insertDraft uses defaults for auto-increment and generated columns", () => {
    const draft = insertDraft(meta);
    expect(draft.id).toEqual({ useDefault: true });
    expect(draft.total).toEqual({ useDefault: true });
  });
  test("nullable columns start as NULL and required ones as empty text", () => {
    const draft = insertDraft(meta);
    expect(draft.note).toEqual({ set: null });
    expect(draft.name).toEqual({ set: "" });
  });
  test("columns with a default and binary columns use the default", () => {
    const draft = insertDraft(meta);
    expect(draft.made).toEqual({ useDefault: true });
    expect(draft.photo).toEqual({ useDefault: true });
  });
});

describe("buildInsert", () => {
  const drafts = (): Record<string, CellDraft> =>
    Object.fromEntries(
      Object.entries(insertDraft(meta)).map(([name, edit]) => [name, toDraft(edit)]),
    );
  function toDraft(edit: ReturnType<typeof insertDraft>[string]): CellDraft {
    if ("useDefault" in edit) return { mode: "default" };
    return edit.set === null ? { mode: "null" } : { mode: "value", text: edit.set };
  }

  test("sends editable columns only", () => {
    const result = buildInsert(meta, ref, { ...drafts(), name: value("Ada") });
    expect(result).toEqual({
      ref,
      values: {
        id: { useDefault: true },
        name: { set: "Ada" },
        note: { set: null },
        made: { useDefault: true },
      },
    });
  });
  test("returns the error of each invalid field instead of a request", () => {
    const result = buildInsert(meta, ref, { ...drafts(), id: value("x") });
    expect(result).toEqual({ errors: { id: "Enter a whole number." } });
  });
});

describe("describeEdit", () => {
  test("shows NULL muted, text as typed and defaults by name", () => {
    expect(describeEdit({ set: null })).toEqual({ text: "NULL", muted: true });
    expect(describeEdit({ set: "" })).toEqual({ text: "", muted: false });
    expect(describeEdit({ set: "x" })).toEqual({ text: "x", muted: false });
    expect(describeEdit({ useDefault: true })).toEqual({ text: "DEFAULT", muted: true });
  });
});

describe("describeEditError", () => {
  test("row_not_found", () => {
    expect(describeEditError({ status: 404, code: "row_not_found", message: "x" })).toBe(
      "This row no longer exists. Reload the table to see what changed.",
    );
  });
  test("key_not_unique", () => {
    expect(describeEditError({ status: 409, code: "key_not_unique", message: "x" })).toBe(
      "More than one row has this key, so nothing was changed.",
    );
  });
  test("not_editable keeps the server's reason", () => {
    expect(describeEditError({ status: 409, code: "not_editable", message: "No key." })).toBe(
      "This table can't be edited. No key.",
    );
  });
  test("read_only", () => {
    expect(describeEditError({ status: 403, code: "read_only", message: "x" })).toBe(
      "This connection is read-only.",
    );
  });
  test("invalid_request shows the server's message", () => {
    expect(
      describeEditError({ status: 400, code: "invalid_request", message: "Unknown column z." }),
    ).toBe("Unknown column z.");
  });
  test("an upload that is too large wins over its invalid_request code", () => {
    expect(
      describeEditError({
        status: 413,
        code: "invalid_request",
        message: "Cells can be up to 16 MB.",
      }),
    ).toBe("That file is over the 16 MB limit for a cell.");
  });
  test("driver errors such as a Postgres type error are passed through", () => {
    expect(
      describeEditError({
        status: 400,
        code: "query_failed",
        message: 'invalid input syntax for type integer: "x"',
      }),
    ).toBe('invalid input syntax for type integer: "x"');
  });
});
