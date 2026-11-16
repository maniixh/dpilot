import type {
  ConfirmationRequired,
  HistoryQuery,
  QueryRequest,
  QueryRun,
  SavedQueryInput,
  SavedQueryPatch,
} from "@dpilot/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, toApiError, unwrap, unwrapEmpty } from "./client.ts";
import { retryUnlessClientError } from "./explorer.ts";

const segment = encodeURIComponent;

export type RunResult =
  | { kind: "run"; run: QueryRun }
  | { kind: "confirm"; statements: ConfirmationRequired["statements"] };

function isConfirmation(body: unknown): body is ConfirmationRequired {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { error?: unknown }).error === "confirmation_required" &&
    Array.isArray((body as { statements?: unknown }).statements)
  );
}

export const queryRequests = {
  /** A 409 confirmation_required isn't a failure: the editor shows its statements and asks. */
  run: async (target: string, request: QueryRequest): Promise<RunResult> => {
    const res = await api.c[":target"].query.$post({
      param: { target: segment(target) },
      json: request,
    });
    if (res.ok) return { kind: "run", run: await res.json() };
    const body: unknown = await res
      .clone()
      .json()
      .catch(() => null);
    if (res.status === 409 && isConfirmation(body)) {
      return { kind: "confirm", statements: body.statements };
    }
    throw await toApiError(res);
  },
  cancel: (target: string, runId: string) =>
    unwrapEmpty(
      api.c[":target"].query[":runId"].cancel.$post({
        param: { target: segment(target), runId },
      }),
    ),
  closeTab: (target: string, tab: string) =>
    unwrapEmpty(
      api.c[":target"].sessions[":tab"].$delete({
        param: { target: segment(target), tab },
      }),
    ),
  history: (query: Partial<HistoryQuery>) =>
    unwrap(
      api.history.$get({
        query: Object.fromEntries(
          Object.entries(query)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)]),
        ),
      }),
    ),
  removeHistory: (id: number) =>
    unwrapEmpty(api.history[":id"].$delete({ param: { id: String(id) } })),
  clearHistory: (target: string | null) =>
    unwrapEmpty(api.history.$delete({ query: target === null ? {} : { target } })),
  savedQueries: () => unwrap(api["saved-queries"].$get()),
  createSavedQuery: (input: SavedQueryInput) => unwrap(api["saved-queries"].$post({ json: input })),
  updateSavedQuery: (id: string, patch: SavedQueryPatch) =>
    unwrap(api["saved-queries"][":id"].$patch({ param: { id }, json: patch })),
  removeSavedQuery: (id: string) =>
    unwrapEmpty(api["saved-queries"][":id"].$delete({ param: { id } })),
};

export const queryKeys = {
  history: ["history"] as const,
  saved: ["saved-queries"] as const,
};

export function useRunQuery(target: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: QueryRequest) => queryRequests.run(target, request),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.history }),
  });
}

export function useHistory(query: Partial<HistoryQuery>) {
  return useQuery({
    queryKey: [...queryKeys.history, query],
    queryFn: () => queryRequests.history(query),
    retry: retryUnlessClientError,
  });
}

export function useRemoveHistory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: queryRequests.removeHistory,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.history }),
  });
}

export function useClearHistory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: queryRequests.clearHistory,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.history }),
  });
}

export function useSavedQueries() {
  return useQuery({
    queryKey: queryKeys.saved,
    queryFn: queryRequests.savedQueries,
    retry: retryUnlessClientError,
  });
}

export function useCreateSavedQuery() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: queryRequests.createSavedQuery,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.saved }),
  });
}

export function useUpdateSavedQuery() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (update: { id: string; patch: SavedQueryPatch }) =>
      queryRequests.updateSavedQuery(update.id, update.patch),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.saved }),
  });
}

export function useRemoveSavedQuery() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: queryRequests.removeSavedQuery,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.saved }),
  });
}
