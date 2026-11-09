import type { DockerStatus } from "@dpilot/shared";

/** Read-only view of the Docker daemon consumed by HTTP routes. */
export interface DockerClient {
  status(): Promise<DockerStatus>;
}
