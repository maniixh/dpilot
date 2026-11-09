import { parseArgs } from "node:util";

export const DEFAULT_PORT = 7311;

export type CliCommand =
  | { command: "serve"; port: number; portExplicit: boolean; open: boolean; dev: boolean }
  | { command: "help" }
  | { command: "version" };

export class CliUsageError extends Error {
  override name = "CliUsageError";
}

export const HELP_TEXT = `dpilot - manage local databases with Docker and a web UI

Usage: dpilot [options]

Options:
  --port <n>    Port to listen on (default ${DEFAULT_PORT}; next free port if busy)
  --no-open     Do not open the browser
  --dev         Development mode: API only, for use with the Vite dev server
  -v, --version Print the version
  -h, --help    Show this help
`;

export function parseCliArgs(argv: string[]): CliCommand {
  let values: ReturnType<typeof parse>["values"];
  try {
    values = parse(argv).values;
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }

  if (values.help) return { command: "help" };
  if (values.version) return { command: "version" };

  const dev = values.dev === true;
  return {
    command: "serve",
    port: values.port === undefined ? DEFAULT_PORT : parsePort(values.port),
    portExplicit: values.port !== undefined || dev,
    open: !dev && values["no-open"] !== true,
    dev,
  };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      port: { type: "string" },
      "no-open": { type: "boolean" },
      dev: { type: "boolean" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new CliUsageError(`Invalid --port "${raw}": expected an integer between 1 and 65535`);
  }
  return port;
}
