import type { Database } from "bun:sqlite";
import { type HistoryEntry, type HistoryQuery, redactSql } from "@dpilot/shared";
import { z } from "zod";
import type { HistoryStore } from "./types.ts";

const MAX_SQL_CHARS = 100_000;
const MAX_ERROR_CHARS = 2000;
const HIDDEN_ERROR = "The statement failed; details hidden because it contained a secret.";
// Drivers quote the failing SQL inside the message, which can wrap a secret in extra quotes that
// `redactSql` cannot tokenise; any mention of a credential clause hides the whole message.
const SECRET_CLAUSE = /\bidentified\b|\b\w*password\b(?!\s*:\s*(?:yes|no)\b)/i;

function safeError(error: string | null): string | null {
  if (error === null) return null;
  if (redactSql(error) !== error || SECRET_CLAUSE.test(error)) return HIDDEN_ERROR;
  return error.slice(0, MAX_ERROR_CHARS);
}

const rowSchema = z.object({
  id: z.number().int(),
  target: z.string(),
  database: z.string().nullable(),
  sql: z.string(),
  started_at: z.string(),
  duration_ms: z.number(),
  outcome: z.enum(["ok", "error", "cancelled"]),
  statements: z.number().int(),
  rows_affected: z.number(),
  error: z.string().nullable(),
});

function toEntry(raw: unknown): HistoryEntry {
  const row = rowSchema.parse(raw);
  return {
    id: row.id,
    target: row.target,
    database: row.database,
    sql: row.sql,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    outcome: row.outcome,
    statements: row.statements,
    rowsAffected: row.rows_affected,
    error: row.error,
  };
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export function createHistoryStore(db: Database, options: { max?: number } = {}): HistoryStore {
  const max = options.max ?? 5000;

  return {
    add(entry) {
      const sql = redactSql(entry.sql).slice(0, MAX_SQL_CHARS);
      const row = db.transaction(() => {
        const inserted = db
          .query(
            `INSERT INTO query_history (target, database, sql, started_at, duration_ms, outcome,
               statements, rows_affected, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          )
          .get(
            entry.target,
            entry.database,
            sql,
            entry.startedAt,
            entry.durationMs,
            entry.outcome,
            entry.statements,
            entry.rowsAffected,
            safeError(entry.error),
          );
        db.run(
          `DELETE FROM query_history
           WHERE id <= (SELECT id FROM query_history ORDER BY id DESC LIMIT 1 OFFSET ?)`,
          [max],
        );
        return inserted;
      })();
      return toEntry(row);
    },

    list(query: HistoryQuery) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (query.target !== undefined) {
        where.push("target = ?");
        params.push(query.target);
      }
      if (query.search !== undefined && query.search !== "") {
        where.push("sql LIKE ? ESCAPE '\\'");
        params.push(`%${escapeLike(query.search)}%`);
      }
      if (query.before !== undefined) {
        where.push("id < ?");
        params.push(query.before);
      }
      const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const rows = db
        .query(`SELECT * FROM query_history ${clause} ORDER BY id DESC LIMIT ?`)
        .all(...params, query.limit);
      return rows.map(toEntry);
    },

    remove(id) {
      db.run("DELETE FROM query_history WHERE id = ?", [id]);
    },

    clear(target) {
      if (target === null) db.run("DELETE FROM query_history");
      else db.run("DELETE FROM query_history WHERE target = ?", [target]);
    },
  };
}
