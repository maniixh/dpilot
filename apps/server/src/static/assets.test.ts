import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { type AssetSource, diskAssetSource, embeddedAssetSource, staticHandler } from "./assets.ts";

let root: string;
let secretPath: string;

beforeAll(() => {
  const parent = mkdtempSync(join(tmpdir(), "dpilot-static-"));
  root = join(parent, "dist");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>dpilot</title>");
  writeFileSync(join(root, "assets", "app-abc123.js"), "console.log(1)");
  secretPath = join(parent, "secret.txt");
  writeFileSync(secretPath, "do not serve");
});

afterAll(() => rmSync(join(root, ".."), { recursive: true, force: true }));

function appFor(source: AssetSource) {
  return new Hono().get("*", staticHandler(source));
}

describe("staticHandler with diskAssetSource", () => {
  test("serves index.html at / without caching", async () => {
    const res = await appFor(diskAssetSource(root)).request("/");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>dpilot</title>");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("serves hashed files under /assets as immutable", async () => {
    const res = await appFor(diskAssetSource(root)).request("/assets/app-abc123.js");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log(1)");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  test("falls back to index.html for client-side routes", async () => {
    const res = await appFor(diskAssetSource(root)).request("/connections/42");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>dpilot</title>");
  });

  test("returns 404 for a missing file with an extension", async () => {
    expect((await appFor(diskAssetSource(root)).request("/missing.js")).status).toBe(404);
  });

  test.each(["/..%2fsecret.txt", "/assets/..%2f..%2fsecret.txt", "/%2e%2e/secret.txt"])(
    "does not serve files outside the root for %s",
    async (path) => {
      const res = await appFor(diskAssetSource(root)).request(path);
      expect(await res.text()).not.toContain("do not serve");
    },
  );
});

describe("staticHandler with embeddedAssetSource", () => {
  test("serves only files listed in the manifest", async () => {
    const app = appFor(
      embeddedAssetSource({
        "/index.html": join(root, "index.html"),
        "/assets/app-abc123.js": join(root, "assets", "app-abc123.js"),
      }),
    );

    expect(await (await app.request("/assets/app-abc123.js")).text()).toBe("console.log(1)");
    expect(await (await app.request("/")).text()).toContain("<title>dpilot</title>");
    expect((await app.request("/secret.txt")).status).toBe(404);
  });
});
