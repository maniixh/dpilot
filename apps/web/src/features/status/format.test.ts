import { describe, expect, test } from "bun:test";
import { formatUptime } from "./format.ts";

describe("formatUptime", () => {
  test.each([
    [0, "just started"],
    [59, "just started"],
    [60, "1 min"],
    [3599, "59 min"],
    [3600, "1 h 0 min"],
    [90061, "25 h 1 min"],
  ])("%i seconds reads as %s", (seconds, expected) => {
    expect(formatUptime(seconds)).toBe(expected);
  });
});
