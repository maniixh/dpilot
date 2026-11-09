import { describe, expect, test } from "bun:test";
import { CliUsageError, DEFAULT_PORT, parseCliArgs } from "./args.ts";

describe("parseCliArgs", () => {
  test("defaults to serving on the default port with fallback and opening the browser", () => {
    expect(parseCliArgs([])).toEqual({
      command: "serve",
      port: DEFAULT_PORT,
      portExplicit: false,
      open: true,
      dev: false,
    });
  });

  test("--port pins the port so it will not fall back", () => {
    expect(parseCliArgs(["--port", "8080"])).toMatchObject({ port: 8080, portExplicit: true });
  });

  test("--no-open skips opening the browser", () => {
    expect(parseCliArgs(["--no-open"])).toMatchObject({ command: "serve", open: false });
  });

  test("--dev never opens the browser and pins the port for the Vite proxy", () => {
    expect(parseCliArgs(["--dev"])).toMatchObject({ dev: true, open: false, portExplicit: true });
  });

  test.each([["--help"], ["-h"]])("%s shows help", (flag) => {
    expect(parseCliArgs([flag])).toEqual({ command: "help" });
  });

  test.each([["--version"], ["-v"]])("%s shows the version", (flag) => {
    expect(parseCliArgs([flag])).toEqual({ command: "version" });
  });

  test.each(["abc", "0", "70000", "80.5"])("rejects invalid port %s", (port) => {
    expect(() => parseCliArgs(["--port", port])).toThrow(CliUsageError);
  });

  test("rejects unknown flags", () => {
    expect(() => parseCliArgs(["--host", "0.0.0.0"])).toThrow(CliUsageError);
  });
});
