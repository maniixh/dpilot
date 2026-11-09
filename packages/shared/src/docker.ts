export type DockerStatus =
  | {
      state: "running";
      endpoint: string;
      version: string;
      apiVersion: string;
      os: string;
      arch: string;
    }
  | {
      state: "unreachable";
      triedEndpoints: string[];
      reason: string;
    };
