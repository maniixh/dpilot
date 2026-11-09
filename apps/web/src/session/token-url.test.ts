import { describe, expect, test } from "bun:test";
import { takeTokenFromUrl } from "./token-url.ts";

const token = "d".repeat(64);

describe("takeTokenFromUrl", () => {
  test("extracts the token and returns the URL without it", () => {
    expect(takeTokenFromUrl(`http://localhost:5173/tables?token=${token}&tab=data#top`)).toEqual({
      token,
      cleanUrl: "/tables?tab=data#top",
    });
  });

  test("returns null when no token is present", () => {
    expect(takeTokenFromUrl("http://localhost:5173/")).toBeNull();
  });

  test("still strips a malformed token but does not return it", () => {
    expect(takeTokenFromUrl("http://localhost:5173/?token=oops")).toEqual({
      token: null,
      cleanUrl: "/",
    });
  });
});
