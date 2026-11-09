import type { DockerStatus } from "@dpilot/shared";
import { z } from "zod";
import type { DockerEndpoint } from "./endpoint.ts";
import { DockerTransportError, dockerRequest } from "./http.ts";
import {
  type DockerCallOptions,
  type DockerConnection,
  type DockerResponse,
  DockerUnavailableError,
} from "./types.ts";

export interface DockerClientOptions {
  resolveEndpoints: () => DockerEndpoint[];
  /** Default idle timeout for requests. */
  timeoutMs: number;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;

const versionResponseSchema = z.object({
  Version: z.string(),
  ApiVersion: z.string(),
  Os: z.string(),
  Arch: z.string(),
});

/**
 * Finds a reachable Docker Engine endpoint, remembers it, and sends requests to it.
 * A transport failure forgets the endpoint so the next call rediscovers one.
 */
export function createDockerClient(options: DockerClientOptions): DockerConnection {
  let current: DockerEndpoint | null = null;

  async function discover(): Promise<DockerStatus> {
    let endpoints: DockerEndpoint[];
    try {
      endpoints = options.resolveEndpoints();
    } catch (error) {
      return { state: "unreachable", triedEndpoints: [], reason: errorMessage(error) };
    }

    const failures: string[] = [];
    for (const endpoint of endpoints) {
      try {
        const res = await dockerRequest(endpoint, {
          method: "GET",
          path: "/version",
          idleTimeoutMs: options.timeoutMs,
          maxBytes: MAX_RESPONSE_BYTES,
        });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`Docker responded with HTTP ${res.status}`);
        }
        const version = versionResponseSchema.parse(parseJson(res.body));
        current = endpoint;
        return {
          state: "running",
          endpoint: endpoint.label,
          version: version.Version,
          apiVersion: version.ApiVersion,
          os: version.Os,
          arch: version.Arch,
        };
      } catch (error) {
        failures.push(`${endpoint.label}: ${errorMessage(error)}`);
      }
    }

    current = null;
    return {
      state: "unreachable",
      triedEndpoints: endpoints.map((endpoint) => endpoint.label),
      reason: failures.join("; ") || "No Docker endpoints to try",
    };
  }

  return {
    status: discover,

    async request(call: DockerCallOptions): Promise<DockerResponse> {
      if (!current) {
        const status = await discover();
        if (status.state === "unreachable") throw new DockerUnavailableError(status.reason);
      }
      const endpoint = current;
      if (!endpoint) throw new DockerUnavailableError("No Docker endpoint");
      try {
        return await dockerRequest(endpoint, {
          idleTimeoutMs: options.timeoutMs,
          maxBytes: MAX_RESPONSE_BYTES,
          ...call,
        });
      } catch (error) {
        if (error instanceof DockerTransportError) {
          current = null;
          throw new DockerUnavailableError(`${endpoint.label}: ${error.message}`);
        }
        throw error;
      }
    },
  };
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error("Docker returned invalid JSON");
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return "Unexpected response from Docker";
  return error instanceof Error ? error.message : String(error);
}
