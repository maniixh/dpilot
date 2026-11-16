import { describe, expect, test } from "bun:test";
import type { Sort } from "@dpilot/shared";
import {
  aggregateFns,
  type FilterDraft,
  filterOps,
  formatCell,
  pageLabel,
  parseFilterDraft,
  toggleSort,
} from "./grid-model.ts";

describe("formatCell", () => {
  test("null is a muted NULL", () => {
    expect(formatCell(null, "text")).toEqual({ text: "NULL", muted: true });
  });
  test("text is shown exactly, including whitespace", () => {
    expect(formatCell("  a\tb ", "text")).toEqual({ text: "  a\tb ", muted: false });
  });
  test("an empty string is not NULL", () => {
    expect(formatCell("", "text")).toEqual({ text: "", muted: false });
  });
  test("a bigint above 2^53 keeps every digit", () => {
    expect(formatCell("9007199254740993", "integer").text).toBe("9007199254740993");
  });
  test("booleans and numbers", () => {
    expect(formatCell(true, "boolean").text).toBe("true");
    expect(formatCell(false, "boolean").text).toBe("false");
    expect(formatCell(-1.5, "float").text).toBe("-1.5");
  });
  test("bytes show size and a hex prefix", () => {
    const bytes = { size: 12_698, hex: "89504e470d0a1a0a", truncated: true };
    expect(formatCell({ bytes }, "binary")).toEqual({ text: "12.4 KB · 89504e47…", muted: true });
  });
  test("short bytes have no ellipsis and empty bytes read 0 B", () => {
    expect(formatCell({ bytes: { size: 2, hex: "ff00", truncated: false } }, "binary").text).toBe(
      "2 B · ff00",
    );
    expect(formatCell({ bytes: { size: 0, hex: "", truncated: false } }, "binary").text).toBe(
      "0 B",
    );
  });
});

describe("toggleSort", () => {
  const asc: Sort = { column: "a", direction: "asc" };
  const desc: Sort = { column: "a", direction: "desc" };
  const b: Sort = { column: "b", direction: "asc" };

  test("cycles ascending, descending, none", () => {
    const first = toggleSort([], "a", false);
    expect(first).toEqual([asc]);
    const second = toggleSort(first, "a", false);
    expect(second).toEqual([desc]);
    expect(toggleSort(second, "a", false)).toEqual([]);
  });
  test("a plain click replaces other columns", () => {
    expect(toggleSort([b], "a", false)).toEqual([asc]);
  });
  test("a plain click on a multi-column sort keeps only that column", () => {
    expect(toggleSort([asc, b], "a", false)).toEqual([desc]);
  });
  test("additive click appends and cycles in place", () => {
    expect(toggleSort([b], "a", true)).toEqual([b, asc]);
    expect(toggleSort([asc, b], "a", true)).toEqual([desc, b]);
    expect(toggleSort([desc, b], "a", true)).toEqual([b]);
  });
  test("additive click stops at five columns", () => {
    const five = ["a", "b", "c", "d", "e"].map((column): Sort => ({ column, direction: "asc" }));
    expect(toggleSort(five, "f", true)).toEqual(five);
  });
});

describe("pageLabel", () => {
  test("first page", () => expect(pageLabel(0, 12_408, 100)).toBe("1–100 of 12,408"));
  test("last partial page", () =>
    expect(pageLabel(12_400, 12_408, 8)).toBe("12,401–12,408 of 12,408"));
  test("empty", () => expect(pageLabel(0, 0, 0)).toBe("No rows"));
  test("count not known yet", () => expect(pageLabel(100, null, 100)).toBe("101–200"));
  test("page past the end", () => expect(pageLabel(500, 20, 0)).toBe("No rows on this page"));
});

describe("filterOps", () => {
  test("numbers compare but do not pattern-match", () => {
    const ops = filterOps("integer");
    expect(ops).toContain("gt");
    expect(ops).not.toContain("like");
  });
  test("text can pattern-match", () => expect(filterOps("text")).toContain("like"));
  test("every kind can test for null", () => {
    for (const kind of ["text", "integer", "json", "binary", "boolean", "other"] as const) {
      expect(filterOps(kind)).toContain("is_null");
    }
  });
  test("binary only tests for null", () => {
    expect(filterOps("binary")).toEqual(["is_null", "not_null"]);
  });
});

describe("aggregateFns", () => {
  test("sum and avg are for numbers only", () => {
    expect(aggregateFns("decimal")).toEqual(["count", "sum", "avg", "min", "max"]);
    expect(aggregateFns("text")).toEqual(["count", "min", "max"]);
  });
  test("json and binary only count", () => {
    expect(aggregateFns("json")).toEqual(["count"]);
    expect(aggregateFns("binary")).toEqual(["count"]);
  });
});

describe("parseFilterDraft", () => {
  const draft = (over: Partial<FilterDraft>): FilterDraft => ({
    column: "name",
    op: "eq",
    value: "x",
    ...over,
  });

  test("a value filter", () => {
    expect(parseFilterDraft(draft({}))).toEqual({ op: "eq", column: "name", value: "x" });
  });
  test("a filter needs a column", () => {
    expect(parseFilterDraft(draft({ column: "" }))).toBe("Pick a column.");
  });
  test("ordering and pattern filters need a value", () => {
    expect(parseFilterDraft(draft({ op: "gt", value: "" }))).toBe("Enter a value.");
  });
  test("eq accepts an empty string", () => {
    expect(parseFilterDraft(draft({ value: "" }))).toEqual({
      op: "eq",
      column: "name",
      value: "",
    });
  });
  test("in splits on commas and trims", () => {
    expect(parseFilterDraft(draft({ op: "in", value: " a, b ,,c " }))).toEqual({
      op: "in",
      column: "name",
      values: ["a", "b", "c"],
    });
  });
  test("in with no values is rejected", () => {
    expect(parseFilterDraft(draft({ op: "in", value: " , " }))).toBe(
      "Enter at least one value, separated by commas.",
    );
  });
  test("in is limited to 100 values", () => {
    const many = Array.from({ length: 101 }, (_, i) => i).join(",");
    expect(parseFilterDraft(draft({ op: "not_in", value: many }))).toBe("Use at most 100 values.");
  });
  test("null tests ignore the value", () => {
    expect(parseFilterDraft(draft({ op: "is_null", value: "junk" }))).toEqual({
      op: "is_null",
      column: "name",
    });
  });
});
