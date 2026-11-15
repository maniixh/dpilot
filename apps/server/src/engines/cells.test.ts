import { describe, expect, test } from "bun:test";
import { encodeCell } from "./cells.ts";

describe("encodeCell", () => {
  test("previews the first 64 bytes of a buffer in lowercase hex", () => {
    const cell = encodeCell(Buffer.alloc(100, 0xab));
    expect(cell).toEqual({ bytes: { size: 100, truncated: true, hex: "ab".repeat(64) } });
  });

  test("does not truncate a short buffer", () => {
    expect(encodeCell(Buffer.from([0xde, 0xad]))).toEqual({
      bytes: { size: 2, truncated: false, hex: "dead" },
    });
  });

  test("keeps bigint as a number only within 2^53", () => {
    expect(encodeCell(5n)).toBe(5);
    expect(encodeCell(9007199254740993n)).toBe("9007199254740993");
    expect(encodeCell(-9007199254740993n)).toBe("-9007199254740993");
  });

  test("turns non-finite numbers into strings", () => {
    expect(encodeCell(Number.NaN)).toBe("NaN");
    expect(encodeCell(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(encodeCell(1.5)).toBe(1.5);
  });

  test("passes null, booleans and strings through", () => {
    expect(encodeCell(null)).toBeNull();
    expect(encodeCell(undefined)).toBeNull();
    expect(encodeCell(true)).toBe(true);
    expect(encodeCell("x")).toBe("x");
  });

  test("encodes dates as ISO strings", () => {
    expect(encodeCell(new Date("2024-01-02T03:04:05.678Z"))).toBe("2024-01-02T03:04:05.678Z");
    expect(encodeCell(new Date(Number.NaN))).toBe("Invalid Date");
  });

  test("stringifies objects and arrays, including nested bigint", () => {
    expect(encodeCell({ a: 1 })).toBe('{"a":1}');
    expect(encodeCell([1, { b: 2n }])).toBe('[1,{"b":"2"}]');
  });
});
