import { request } from "node:http";
import type { DockerStatus } from "@dpilot/shared";
import { z } from "zod";
import type { DockerEndpoint } from "./endpoint.ts";
import type { DockerClient } from "./types.ts";

export interface DockerClientOptions {
  resolveEndpoints: () => DockerEndpoint[];
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
 * Talks to the Docker Engine API with node:http, which (unlike fetch) supports
 * Windows named pipes in Bun via `socketPath`.
 */
export function createDockerClient(options: DockerClientOptions): DockerClient {
  return {
    async status(): Promise<DockerStatus> {
      let endpoints: DockerEndpoint[];
      try {
        endpoints = options.resolveEndpoints();
      } catch (error) {
        return { state: "unreachable", triedEndpoints: [], reason: errorMessage(error) };
      }

      const failures: string[] = [];
      for (const endpoint of endpoints) {
        try {
          const version = versionResponseSchema.parse(
            await getJson(endpoint, "/version", options.timeoutMs),
          );
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

      return {
        state: "unreachable",
        triedEndpoints: endpoints.map((endpoint) => endpoint.label),
        reason: failures.join("; ") || "No Docker endpoints to try",
      };
    },
  };
}

function getJson(endpoint: DockerEndpoint, path: string, timeoutMs: number): Promise<unknown> {
  const target =
    endpoint.transport === "socket"
      ? { socketPath: endpoint.socketPath }
      : { hostname: new URL(endpoint.baseUrl).hostname, port: new URL(endpoint.baseUrl).port };

  return new Promise((resolve, reject) => {
    const req = request({ ...target, path, method: "GET", headers: { host: "docker" } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error("Docker response too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new Error(`Docker responded with HTTP ${status}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new Error("Docker returned invalid JSON"));
        }
      });
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return "Unexpected response from Docker";
  return error instanceof Error ? error.message : String(error);
}
