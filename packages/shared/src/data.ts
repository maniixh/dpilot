import { z } from "zod";
import type { EngineId } from "./catalog.ts";

export type Dialect = "mysql" | "postgres";

export function dialectOf(engine: EngineId): Dialect {
  return engine === "postgres" ? "postgres" : "mysql";
}

export type CellValue =
  | null
  | boolean
  | number
  | string
  | { bytes: { size: number; hex: string; truncated: boolean } };

export const cellValueSchema: z.ZodType<CellValue> = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z
    .object({
      bytes: z
        .object({ size: z.number().int().min(0), hex: z.string(), truncated: z.boolean() })
        .strict(),
    })
    .strict(),
]);

export type ColumnKind =
  | "text"
  | "integer"
  | "decimal"
  | "float"
  | "boolean"
  | "date"
  | "datetime"
  | "time"
  | "json"
  | "binary"
  | "other";

export interface ColumnMeta {
  name: string;
  /** The type as the catalog spells it. */
  type: string;
  kind: ColumnKind;
  nullable: boolean;
  defaultValue: string | null;
  generated: boolean;
  autoIncrement: boolean;
}

export interface TableMeta {
  kind: "table" | "view";
  columns: ColumnMeta[];
  primaryKey: string[];
  editable: boolean;
  readOnlyReason: string | null;
}

const identifierSchema = z.string().min(1).max(128);

export const tableRefSchema = z
  .object({ schema: identifierSchema.nullable(), table: identifierSchema })
  .strict();
export type TableRef = z.infer<typeof tableRefSchema>;

/** Primary-key values travel as exact text so 64-bit keys round-trip. */
export const rowKeySchema = z.record(z.string().min(1).max(128), z.string()).refine((key) => {
  const size = Object.keys(key).length;
  return size >= 1 && size <= 32;
}, "A key needs 1 to 32 columns");
export type RowKey = z.infer<typeof rowKeySchema>;

const valueFilterSchema = z
  .object({
    op: z.enum(["eq", "ne", "lt", "le", "gt", "ge", "like", "not_like"]),
    column: identifierSchema,
    value: z.string(),
  })
  .strict();
const listFilterSchema = z
  .object({
    op: z.enum(["in", "not_in"]),
    column: identifierSchema,
    values: z.array(z.string()).min(1).max(100),
  })
  .strict();
const nullFilterSchema = z
  .object({ op: z.enum(["is_null", "not_null"]), column: identifierSchema })
  .strict();

export const filterSchema = z.discriminatedUnion("op", [
  valueFilterSchema.extend({ op: z.literal("eq") }),
  valueFilterSchema.extend({ op: z.literal("ne") }),
  valueFilterSchema.extend({ op: z.literal("lt") }),
  valueFilterSchema.extend({ op: z.literal("le") }),
  valueFilterSchema.extend({ op: z.literal("gt") }),
  valueFilterSchema.extend({ op: z.literal("ge") }),
  valueFilterSchema.extend({ op: z.literal("like") }),
  valueFilterSchema.extend({ op: z.literal("not_like") }),
  listFilterSchema.extend({ op: z.literal("in") }),
  listFilterSchema.extend({ op: z.literal("not_in") }),
  nullFilterSchema.extend({ op: z.literal("is_null") }),
  nullFilterSchema.extend({ op: z.literal("not_null") }),
]);
export type Filter = z.infer<typeof filterSchema>;

export const sortSchema = z
  .object({ column: identifierSchema, direction: z.enum(["asc", "desc"]) })
  .strict();
export type Sort = z.infer<typeof sortSchema>;

const filteringFields = {
  ref: tableRefSchema,
  filters: z.array(filterSchema).max(20),
  search: z.string().max(200).nullable(),
};

export const rowsQuerySchema = z
  .object({
    ...filteringFields,
    sort: z.array(sortSchema).max(5),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1).max(1000),
  })
  .strict();
export type RowsQuery = z.infer<typeof rowsQuerySchema>;

/** `keys` is null when the table is not editable. */
export interface RowsPage {
  rows: CellValue[][];
  keys: RowKey[] | null;
}

export const countRequestSchema = z.object(filteringFields).strict();
export type CountRequest = z.infer<typeof countRequestSchema>;

export const aggregateFnSchema = z.enum(["count", "sum", "avg", "min", "max"]);
export type AggregateFn = z.infer<typeof aggregateFnSchema>;

export const aggregateRequestSchema = z
  .object({
    ...filteringFields,
    aggregates: z
      .array(
        z
          .object({ fn: aggregateFnSchema, column: identifierSchema.nullable() })
          .strict()
          .refine((aggregate) => aggregate.column !== null || aggregate.fn === "count", {
            message: "Only count can run without a column",
            path: ["column"],
          }),
      )
      .min(1)
      .max(10),
  })
  .strict();
export type AggregateRequest = z.infer<typeof aggregateRequestSchema>;

export interface AggregateResult {
  values: CellValue[];
}

export const editValueSchema = z.union([
  z.object({ set: z.string().nullable() }).strict(),
  z.object({ useDefault: z.literal(true) }).strict(),
]);
export type EditValue = z.infer<typeof editValueSchema>;

const editValuesSchema = z.record(identifierSchema, editValueSchema);

export const insertRequestSchema = z
  .object({ ref: tableRefSchema, values: editValuesSchema })
  .strict();
export type InsertRequest = z.infer<typeof insertRequestSchema>;

export const updateRequestSchema = z
  .object({ ref: tableRefSchema, key: rowKeySchema, values: editValuesSchema })
  .strict();
export type UpdateRequest = z.infer<typeof updateRequestSchema>;

export const deleteRequestSchema = z
  .object({ ref: tableRefSchema, keys: z.array(rowKeySchema).min(1).max(500) })
  .strict();
export type DeleteRequest = z.infer<typeof deleteRequestSchema>;

export interface EditResult {
  affected: number;
}

export type DataErrorCode =
  | "invalid_request"
  | "read_only"
  | "not_editable"
  | "row_not_found"
  | "key_not_unique"
  | "confirmation_required"
  | "busy"
  | "run_not_found";
