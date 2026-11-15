import { z } from "zod";
import { targetIdSchema } from "./connections.ts";
import type { CellValue, ColumnKind } from "./data.ts";

export const MAX_SCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_SAVED_QUERY_CHARS = 1024 * 1024;

export const queryRequestSchema = z
  .object({
    runId: z.uuid(),
    sql: z.string().max(MAX_SCRIPT_BYTES),
    database: z.string().min(1).max(128).nullable(),
    tab: z.uuid(),
    maxRows: z.number().int().min(1).max(10_000).default(1000),
    confirmed: z.boolean(),
  })
  .strict();
export type QueryRequest = z.infer<typeof queryRequestSchema>;

export type StatementOutcome = { index: number; sql: string; durationMs: number } & (
  | {
      kind: "rows";
      columns: { name: string; kind: ColumnKind }[];
      rows: CellValue[][];
      truncated: boolean;
    }
  | { kind: "affected"; command: string | null; affected: number }
  | { kind: "error"; message: string; position: number | null }
);

export interface QueryRun {
  runId: string;
  outcomes: StatementOutcome[];
  /** Outcomes dropped from the middle once more than 100 were produced. */
  omitted: number;
  summary: { statements: number; succeeded: number; affected: number };
  stopped: null | "error" | "cancelled";
  durationMs: number;
}

export interface ConfirmationRequired {
  error: "confirmation_required";
  message: string;
  statements: { index: number; sql: string; reasons: string[] }[];
}

export interface HistoryEntry {
  id: number;
  target: string;
  database: string | null;
  sql: string;
  startedAt: string;
  durationMs: number;
  outcome: "ok" | "error" | "cancelled";
  statements: number;
  rowsAffected: number;
  error: string | null;
}

export const historyQuerySchema = z
  .object({
    target: targetIdSchema.optional(),
    search: z.string().max(200).optional(),
    before: z.number().int().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

export const savedQueryInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    target: targetIdSchema.nullable(),
    database: z.string().min(1).max(128).nullable(),
    sql: z.string().max(MAX_SAVED_QUERY_CHARS),
  })
  .strict();
export type SavedQueryInput = z.infer<typeof savedQueryInputSchema>;

export const savedQueryPatchSchema = savedQueryInputSchema.partial().strict();
export type SavedQueryPatch = z.infer<typeof savedQueryPatchSchema>;

export interface SavedQuery extends SavedQueryInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}
