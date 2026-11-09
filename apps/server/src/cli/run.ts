import { homedir } from "node:os";
import { createApp } from "../app.ts";
import { createDockerHubVersions } from "../catalog/versions.ts";
import { createDockerClient } from "../docker/client.ts";
import { resolveDockerEndpoints } from "../docker/endpoint.ts";
import { createDockerEngineApi } from "../docker/engine-api.ts";
import { createInstanceService } from "../instances/service.ts";
import { type AssetSource, staticHandler } from "../static/assets.ts";
import { CliUsageError, HELP_TEXT, parseCliArgs } from "./args.ts";
import { openBrowser } from "./browser.ts";
import { PortInUseError, startServer } from "./listen.ts";
import { generatePassword, isPortFree } from "./runtime.ts";
import { generateSessionToken, loadOrCreateDevToken } from "./token.ts";

export interface RunCliOptions {
  argv: string[];
  version: string;
  /** Built web UI; required unless running with --dev. */
  assets: AssetSource;
  /** Where --dev persists its token; null when --dev is unavailable (compiled binary). */
  devTokenPath: string | null;
}

const VITE_DEV_URL = "http://localhost:5173";
const DOCKER_TIMEOUT_MS = 2000;
const DOCKER_HUB_TIMEOUT_MS = 5000;

/** Returns a process exit code, or null while the server keeps running. */
export function runCli(options: RunCliOptions): number | null {
  try {
    return run(options);
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(`${error.message}\n\nRun "dpilot --help" for usage.`);
      return 2;
    }
    if (error instanceof PortInUseError) {
      console.error(`${error.message}. Choose another with --port <n>.`);
      return 1;
    }
    throw error;
  }
}

function run(options: RunCliOptions): number | null {
  const args = parseCliArgs(options.argv);
  if (args.command === "help") {
    console.log(HELP_TEXT);
    return 0;
  }
  if (args.command === "version") {
    console.log(options.version);
    return 0;
  }

  if (args.dev && options.devTokenPath === null) {
    throw new CliUsageError("--dev is only available when running Dpilot from source");
  }
  if (!args.dev && options.assets.resolve("/index.html") === null) {
    console.error('Web UI is not built. Run "bun run build" first, or use --dev.');
    return 1;
  }

  const token =
    args.dev && options.devTokenPath !== null
      ? loadOrCreateDevToken(options.devTokenPath)
      : generateSessionToken();
  const docker = createDockerClient({
    resolveEndpoints: () =>
      resolveDockerEndpoints({ env: process.env, platform: process.platform, homeDir: homedir() }),
    timeoutMs: DOCKER_TIMEOUT_MS,
  });
  const instances = createInstanceService({
    docker: createDockerEngineApi(docker),
    isPortFree,
    generatePassword,
  });
  const versions = createDockerHubVersions({
    get: (url) => fetch(url, { signal: AbortSignal.timeout(DOCKER_HUB_TIMEOUT_MS) }),
    now: Date.now,
  });
  const app = createApp({
    token,
    version: options.version,
    startedAt: Date.now(),
    now: Date.now,
    docker,
    instances,
    versions,
    staticFiles: args.dev ? null : staticHandler(options.assets),
  });

  const server = startServer({
    port: args.port,
    allowFallback: !args.portExplicit,
    fetch: app.fetch,
  });
  const baseUrl = args.dev ? VITE_DEV_URL : `http://127.0.0.1:${server.port}`;
  const url = `${baseUrl}/?token=${token}`;

  console.log(`dpilot ${options.version} listening on http://127.0.0.1:${server.port}`);
  console.log(`Open: ${url}`);
  if (args.open) openBrowser(url);
  return null;
}
