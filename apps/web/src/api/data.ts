import type {
  AggregateRequest,
  CountRequest,
  DeleteRequest,
  EditResult,
  InsertRequest,
  RowKey,
  RowsQuery,
  TableRef,
  UpdateRequest,
} from "@dpilot/shared";
import {
  keepPreviousData,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, unwrap } from "./client.ts";
import { explorerKeys, retryUnlessClientError } from "./explorer.ts";

/** Hono's client inserts path params verbatim, so names are encoded here. */
const segment = encodeURIComponent;

const dbParam = (target: string, db: string) => ({
  param: { target: segment(target), db: segment(db) },
});

const tableQuery = (ref: TableRef): { table: string; schema?: string } =>
  ref.schema === null ? { table: ref.table } : { schema: ref.schema, table: ref.table };

function isEditResult(body: unknown): body is EditResult {
  return (
    typeof body === "object" && body !== null && typeof (body as EditResult).affected === "number"
  );
}

export const dataRequests = {
  table: (target: string, db: string, ref: TableRef) =>
    unwrap(
      api.c[":target"].db[":db"].table.$get({ ...dbParam(target, db), query: tableQuery(ref) }),
    ),
  rows: (target: string, db: string, query: RowsQuery) =>
    unwrap(api.c[":target"].db[":db"].rows.$post({ ...dbParam(target, db), json: query })),
  count: (target: string, db: string, request: CountRequest) =>
    unwrap(api.c[":target"].db[":db"].rows.count.$post({ ...dbParam(target, db), json: request })),
  aggregate: (target: string, db: string, request: AggregateRequest) =>
    unwrap(
      api.c[":target"].db[":db"].rows.aggregate.$post({ ...dbParam(target, db), json: request }),
    ),
  insert: (target: string, db: string, request: InsertRequest) =>
    unwrap(api.c[":target"].db[":db"].rows.insert.$post({ ...dbParam(target, db), json: request })),
  update: (target: string, db: string, request: UpdateRequest) =>
    unwrap(api.c[":target"].db[":db"].rows.update.$post({ ...dbParam(target, db), json: request })),
  remove: (target: string, db: string, request: DeleteRequest) =>
    unwrap(api.c[":target"].db[":db"].rows.delete.$post({ ...dbParam(target, db), json: request })),
  completion: (target: string, db: string, schema: string | null) =>
    unwrap(
      api.c[":target"].db[":db"].completion.$get({
        ...dbParam(target, db),
        query: schema === null ? {} : { schema },
      }),
    ),
  uploadCell: async (
    target: string,
    db: string,
    ref: TableRef,
    key: RowKey,
    column: string,
    bytes: Blob,
  ) => {
    const body: unknown = await unwrap(
      fetch(cellUrl(target, db, ref, key, column), {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
      }),
    );
    if (!isEditResult(body)) throw new Error("Unexpected response to a cell upload");
    return body;
  },
};

/** Where a cell's bytes download from; the key travels as JSON text so 64-bit ids stay exact. */
export function cellUrl(
  target: string,
  db: string,
  ref: TableRef,
  key: RowKey,
  column: string,
): string {
  const query = new URLSearchParams();
  if (ref.schema !== null) query.set("schema", ref.schema);
  query.set("table", ref.table);
  query.set("column", column);
  query.set("key", JSON.stringify(key));
  return `/api/c/${segment(target)}/db/${segment(db)}/cell?${query}`;
}

export const dataKeys = {
  db: (target: string, db: string) => [...explorerKeys.target(target), "db", db, "data"] as const,
  table: (target: string, db: string, ref: TableRef) =>
    [...dataKeys.db(target, db), ref.schema, ref.table] as const,
  meta: (target: string, db: string, ref: TableRef) =>
    [...dataKeys.table(target, db, ref), "meta"] as const,
  rows: (target: string, db: string, query: RowsQuery) =>
    [...dataKeys.table(target, db, query.ref), "rows", query] as const,
  count: (target: string, db: string, request: CountRequest) =>
    [...dataKeys.table(target, db, request.ref), "count", request] as const,
  aggregate: (target: string, db: string, request: AggregateRequest) =>
    [...dataKeys.table(target, db, request.ref), "aggregate", request] as const,
  completion: (target: string, db: string, schema: string | null) =>
    [...dataKeys.db(target, db), "completion", schema] as const,
};

export function useTableMeta(target: string, db: string, ref: TableRef) {
  return useQuery({
    queryKey: dataKeys.meta(target, db, ref),
    queryFn: () => dataRequests.table(target, db, ref),
    retry: retryUnlessClientError,
  });
}

export function useRows(target: string, db: string, query: RowsQuery, enabled = true) {
  return useQuery({
    queryKey: dataKeys.rows(target, db, query),
    queryFn: () => dataRequests.rows(target, db, query),
    placeholderData: keepPreviousData,
    enabled,
    retry: retryUnlessClientError,
  });
}

export function useRowCount(target: string, db: string, request: CountRequest, enabled = true) {
  return useQuery({
    queryKey: dataKeys.count(target, db, request),
    queryFn: () => dataRequests.count(target, db, request),
    placeholderData: keepPreviousData,
    enabled,
    retry: retryUnlessClientError,
  });
}

export function useAggregate(
  target: string,
  db: string,
  request: AggregateRequest,
  enabled = true,
) {
  return useQuery({
    queryKey: dataKeys.aggregate(target, db, request),
    queryFn: () => dataRequests.aggregate(target, db, request),
    placeholderData: keepPreviousData,
    enabled,
    retry: retryUnlessClientError,
  });
}

export function useCompletion(target: string, db: string, schema: string | null, enabled = true) {
  return useQuery({
    queryKey: dataKeys.completion(target, db, schema),
    queryFn: () => dataRequests.completion(target, db, schema),
    enabled,
    staleTime: 60_000,
    retry: retryUnlessClientError,
  });
}

function refreshTable(client: QueryClient, target: string, db: string, ref: TableRef) {
  const base = dataKeys.table(target, db, ref);
  return Promise.all(
    (["rows", "count", "aggregate"] as const).map((part) =>
      client.invalidateQueries({ queryKey: [...base, part] }),
    ),
  );
}

export function useInsertRow(target: string, db: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: InsertRequest) => dataRequests.insert(target, db, request),
    onSuccess: (_result, request) => refreshTable(client, target, db, request.ref),
  });
}

export function useUpdateRow(target: string, db: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: UpdateRequest) => dataRequests.update(target, db, request),
    onSuccess: (_result, request) => refreshTable(client, target, db, request.ref),
  });
}

export function useDeleteRows(target: string, db: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: DeleteRequest) => dataRequests.remove(target, db, request),
    onSuccess: (_result, request) => refreshTable(client, target, db, request.ref),
  });
}

export function useUploadCell(target: string, db: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (upload: { ref: TableRef; key: RowKey; column: string; bytes: Blob }) =>
      dataRequests.uploadCell(target, db, upload.ref, upload.key, upload.column, upload.bytes),
    onSuccess: (_result, upload) => refreshTable(client, target, db, upload.ref),
  });
}
