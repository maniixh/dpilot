import { useQuery } from "@tanstack/react-query";
import { ApiError, api, unwrap } from "./client.ts";

const TARGETS_REFRESH_MS = 10_000;

/** Hono's client inserts path params verbatim, so names are encoded here. */
const segment = encodeURIComponent;

export const explorerRequests = {
  targets: () => unwrap(api.targets.$get()),
  info: (target: string) =>
    unwrap(api.c[":target"].info.$get({ param: { target: segment(target) } })),
  variables: (target: string) =>
    unwrap(api.c[":target"].variables.$get({ param: { target: segment(target) } })),
  databases: (target: string) =>
    unwrap(api.c[":target"].databases.$get({ param: { target: segment(target) } })),
  schemas: (target: string, db: string) =>
    unwrap(
      api.c[":target"].db[":db"].schemas.$get({
        param: { target: segment(target), db: segment(db) },
      }),
    ),
  objects: (target: string, db: string, schema: string | null) =>
    unwrap(
      api.c[":target"].db[":db"].objects.$get({
        param: { target: segment(target), db: segment(db) },
        query: schema === null ? {} : { schema },
      }),
    ),
};

/** Client errors (bad id, stopped server, wrong password) won't fix themselves on retry. */
export function retryUnlessClientError(count: number, error: Error): boolean {
  return !(error instanceof ApiError && error.status < 500) && count < 2;
}

export const explorerKeys = {
  targets: ["targets"] as const,
  target: (target: string) => ["c", target] as const,
};

export function useTargets() {
  return useQuery({
    queryKey: explorerKeys.targets,
    queryFn: explorerRequests.targets,
    refetchInterval: TARGETS_REFRESH_MS,
    retry: retryUnlessClientError,
  });
}

export function useServerInfo(target: string) {
  return useQuery({
    queryKey: [...explorerKeys.target(target), "info"],
    queryFn: () => explorerRequests.info(target),
    retry: retryUnlessClientError,
  });
}

export function useVariables(target: string) {
  return useQuery({
    queryKey: [...explorerKeys.target(target), "variables"],
    queryFn: () => explorerRequests.variables(target),
    retry: retryUnlessClientError,
  });
}

export function useDatabases(target: string, enabled: boolean) {
  return useQuery({
    queryKey: [...explorerKeys.target(target), "databases"],
    queryFn: () => explorerRequests.databases(target),
    enabled,
    retry: retryUnlessClientError,
  });
}

export function useSchemas(target: string, db: string, enabled: boolean) {
  return useQuery({
    queryKey: [...explorerKeys.target(target), "db", db, "schemas"],
    queryFn: () => explorerRequests.schemas(target, db),
    enabled,
    retry: retryUnlessClientError,
  });
}

export function useObjects(target: string, db: string, schema: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [...explorerKeys.target(target), "db", db, "objects", schema],
    queryFn: () => explorerRequests.objects(target, db, schema),
    enabled,
    retry: retryUnlessClientError,
  });
}
