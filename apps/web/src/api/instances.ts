import type { CreateInstanceRequest, EngineId } from "@dpilot/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type InstanceAction, pollInterval } from "../features/instances/present.ts";
import { ApiError, api, unwrap, unwrapEmpty } from "./client.ts";

const keys = {
  instances: ["instances"] as const,
  instance: (name: string) => ["instances", name] as const,
};

export type { InstanceAction };

export function useEngines() {
  return useQuery({
    queryKey: ["catalog", "engines"],
    queryFn: () => unwrap(api.catalog.engines.$get()),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useEngineVersions(engine: EngineId) {
  return useQuery({
    queryKey: ["catalog", "versions", engine],
    queryFn: () => unwrap(api.catalog.engines[":engine"].versions.$get({ param: { engine } })),
    staleTime: 60 * 60 * 1000,
  });
}

export function useInstances() {
  return useQuery({
    queryKey: keys.instances,
    queryFn: () => unwrap(api.instances.$get()),
    refetchInterval: (query) =>
      pollInterval(
        query.state.data?.map((i) => i.state),
        query.state.error,
      ),
  });
}

export function useInstance(name: string) {
  return useQuery({
    queryKey: keys.instance(name),
    queryFn: () => unwrap(api.instances[":name"].$get({ param: { name } })),
    refetchInterval: (query) =>
      pollInterval(query.state.data && [query.state.data.state], query.state.error),
    retry: (count, error) =>
      !(error instanceof ApiError && (error.status === 401 || error.status === 404)) && count < 2,
  });
}

export function useInstanceStats(name: string, enabled: boolean) {
  return useQuery({
    queryKey: [...keys.instance(name), "stats"],
    queryFn: () => unwrap(api.instances[":name"].stats.$get({ param: { name } })),
    enabled,
    refetchInterval: 3000,
  });
}

export function useInstanceLogs(name: string, enabled: boolean) {
  return useQuery({
    queryKey: [...keys.instance(name), "logs"],
    queryFn: () =>
      unwrap(api.instances[":name"].logs.$get({ param: { name }, query: { tail: "200" } })),
    enabled,
    refetchInterval: 5000,
  });
}

export function useInstanceCompose(name: string, enabled: boolean) {
  return useQuery({
    queryKey: [...keys.instance(name), "compose"],
    queryFn: () => unwrap(api.instances[":name"].compose.$get({ param: { name } })),
    enabled,
  });
}

export function useCreateInstance() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateInstanceRequest) => unwrap(api.instances.$post({ json: request })),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.instances }),
  });
}

export function useInstanceAction(name: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: InstanceAction) =>
      unwrapEmpty(api.instances[":name"][":action"].$post({ param: { name, action } })),
    onSettled: () => client.invalidateQueries({ queryKey: keys.instances }),
  });
}

export function useRemoveInstance(name: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (removeVolume: boolean) =>
      unwrapEmpty(
        api.instances[":name"].$delete({
          param: { name },
          query: { removeVolume: removeVolume ? "true" : "false" },
        }),
      ),
    onSuccess: () => {
      client.removeQueries({ queryKey: keys.instance(name) });
      return client.invalidateQueries({ queryKey: keys.instances });
    },
  });
}
