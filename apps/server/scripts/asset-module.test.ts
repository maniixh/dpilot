import { describe, expect, test } from "bun:test";
import { renderAssetModule } from "./asset-module.ts";

describe("renderAssetModule", () => {
  test("embeds each file and maps its URL path to the import", () => {
    const source = renderAssetModule(["index.html", "assets/app-1.js"], "../../../web/dist");

    expect(source).toContain(
      'import f0 from "../../../web/dist/index.html" with { type: "file" };',
    );
    expect(source).toContain(
      'import f1 from "../../../web/dist/assets/app-1.js" with { type: "file" };',
    );
    expect(source).toContain('"/index.html": f0,');
    expect(source).toContain('"/assets/app-1.js": f1,');
  });

  test("normalizes Windows separators to URL paths", () => {
    const source = renderAssetModule(["index.html", "assets\\app.css"], "../dist");

    expect(source).toContain('from "../dist/assets/app.css"');
    expect(source).toContain('"/assets/app.css": f1,');
  });

  test("escapes quotes and backslashes in file names", () => {
    const source = renderAssetModule(["index.html", 'a"b.txt'], "../dist");

    expect(source).toContain('from "../dist/a\\"b.txt"');
    expect(source).toContain('"/a\\"b.txt": f1,');
  });

  test("refuses to embed a build without index.html", () => {
    expect(() => renderAssetModule(["assets/app.js"], "../dist")).toThrow(/index\.html/);
  });
});
