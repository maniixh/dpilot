import type { ConnectionInput, ConnectionPatch, ConnectionTestRequest } from "@dpilot/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, unwrapEmpty } from "./client.ts";
import { explorerKeys, retryUnlessClientError } from "./explorer.ts";

const keys = {
  connections: ["connections"] as const,
  connection: (id: string) => ["connections", id] as const,
};

const param = (id: string) => ({ param: { id: encodeURIComponent(id) } });

export function useConnections(enabled: boolean) {
  return useQuery({
    queryKey: keys.connections,
    queryFn: () => unwrap(api.connections.$get()),
    enabled,
    retry: retryUnlessClientError,
  });
}

export function useConnection(id: string) {
  return useQuery({
    queryKey: keys.connection(id),
    queryFn: () => unwrap(api.connections[":id"].$get(param(id))),
    retry: retryUnlessClientError,
  });
}

function useInvalidate() {
  const client = useQueryClient();
  return (id: string | null) => {
    if (id !== null) client.removeQueries({ queryKey: explorerKeys.target(`c.${id}`) });
    return Promise.all([
      client.invalidateQueries({ queryKey: explorerKeys.targets }),
      client.invalidateQueries({ queryKey: keys.connections }),
    ]);
  };
}

export function useCreateConnection() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: ConnectionInput) => unwrap(api.connections.$post({ json: input })),
    onSuccess: () => invalidate(null),
  });
}

export function useUpdateConnection(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (patch: ConnectionPatch) =>
      unwrap(api.connections[":id"].$patch({ ...param(id), json: patch })),
    onSuccess: () => invalidate(id),
  });
}

export function useDeleteConnection(id: string) {
  const invalidate = useInvalidate();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => unwrapEmpty(api.connections[":id"].$delete(param(id))),
    onSuccess: () => {
      client.removeQueries({ queryKey: keys.connection(id) });
      return invalidate(id);
    },
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: (request: ConnectionTestRequest) =>
      unwrap(api.connections.test.$post({ json: request })),
  });
}
