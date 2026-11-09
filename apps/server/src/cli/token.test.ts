import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSessionToken, loadOrCreateDevToken } from "./token.ts";

const dir = mkdtempSync(join(tmpdir(), "dpilot-token-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

describe("generateSessionToken", () => {
  test("produces distinct 32-byte hex tokens", () => {
    const first = generateSessionToken();
    expect(first).toMatch(TOKEN_PATTERN);
    expect(generateSessionToken()).not.toBe(first);
  });
});

describe("loadOrCreateDevToken", () => {
  test("persists the token so dev restarts keep the browser session", () => {
    const file = join(dir, "stable-token");

    const first = loadOrCreateDevToken(file);

    expect(first).toMatch(TOKEN_PATTERN);
    expect(loadOrCreateDevToken(file)).toBe(first);
    expect(readFileSync(file, "utf8").trim()).toBe(first);
  });

  test("replaces a corrupted token file", () => {
    const file = join(dir, "corrupt-token");
    writeFileSync(file, "not-a-token");

    expect(loadOrCreateDevToken(file)).toMatch(TOKEN_PATTERN);
  });
});
