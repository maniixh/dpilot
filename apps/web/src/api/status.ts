import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "./client.ts";

export function useHealth(enabled: boolean) {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => unwrap(api.health.$get()),
    enabled,
  });
}

export function useDockerStatus(enabled: boolean) {
  return useQuery({
    queryKey: ["docker", "status"],
    queryFn: () => unwrap(api.docker.status.$get()),
    enabled,
    refetchInterval: 10_000,
  });
}
