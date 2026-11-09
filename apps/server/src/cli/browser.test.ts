import { describe, expect, test } from "bun:test";
import { browserCommand } from "./browser.ts";

const url = "http://127.0.0.1:7311/?token=abc&x=1";

describe("browserCommand", () => {
  test("on Windows passes the URL as an argument, never through cmd.exe", () => {
    const command = browserCommand("win32", url);

    expect(command).toEqual(["rundll32", "url.dll,FileProtocolHandler", url]);
  });

  test("uses open on macOS and xdg-open elsewhere", () => {
    expect(browserCommand("darwin", url)).toEqual(["open", url]);
    expect(browserCommand("linux", url)).toEqual(["xdg-open", url]);
  });
});
