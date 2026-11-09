import { posix } from "node:path";

export type DockerEndpoint =
  | { transport: "socket"; socketPath: string; label: string }
  | { transport: "tcp"; baseUrl: string; label: string };

export interface ResolveDockerEndpointsInput {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homeDir: string;
}

export class UnsupportedDockerHostError extends Error {
  override name = "UnsupportedDockerHostError";
}

const WINDOWS_PIPES = ["docker_engine", "dockerDesktopLinuxEngine"] as const;

/**
 * Candidate Docker Engine endpoints in priority order.
 * An explicit DOCKER_HOST wins and is the only candidate.
 */
export function resolveDockerEndpoints(input: ResolveDockerEndpointsInput): DockerEndpoint[] {
  const dockerHost = input.env.DOCKER_HOST?.trim();
  if (dockerHost) {
    return [parseDockerHost(dockerHost, Boolean(input.env.DOCKER_TLS_VERIFY))];
  }

  if (input.platform === "win32") {
    return WINDOWS_PIPES.map((pipe) => parseDockerHost(`npipe:////./pipe/${pipe}`, false));
  }

  return unixSocketCandidates(input).map((socketPath) =>
    parseDockerHost(`unix://${socketPath}`, false),
  );
}

function unixSocketCandidates({ env, platform, homeDir }: ResolveDockerEndpointsInput): string[] {
  const system = "/var/run/docker.sock";
  if (platform === "darwin") {
    return [system, posix.join(homeDir, ".docker", "run", "docker.sock")];
  }
  const rootless = env.XDG_RUNTIME_DIR ? [posix.join(env.XDG_RUNTIME_DIR, "docker.sock")] : [];
  return [system, ...rootless, posix.join(homeDir, ".docker", "desktop", "docker.sock")];
}

function parseDockerHost(dockerHost: string, tlsVerify: boolean): DockerEndpoint {
  if (dockerHost.startsWith("unix://")) {
    return {
      transport: "socket",
      socketPath: dockerHost.slice("unix://".length),
      label: dockerHost,
    };
  }

  if (dockerHost.startsWith("npipe://")) {
    const pipePath = dockerHost.slice("npipe://".length).replaceAll("/", "\\");
    return { transport: "socket", socketPath: pipePath, label: dockerHost };
  }

  if (dockerHost.startsWith("tcp://")) {
    if (tlsVerify) {
      throw new UnsupportedDockerHostError(
        `DOCKER_HOST ${dockerHost} requires TLS (DOCKER_TLS_VERIFY), which Dpilot does not support yet`,
      );
    }
    return {
      transport: "tcp",
      baseUrl: `http://${dockerHost.slice("tcp://".length)}`,
      label: dockerHost,
    };
  }

  throw new UnsupportedDockerHostError(`Unsupported DOCKER_HOST scheme: ${dockerHost}`);
}
