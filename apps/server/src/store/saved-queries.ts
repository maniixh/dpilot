import type { Database } from "bun:sqlite";
import type { SavedQuery } from "@dpilot/shared";
import { z } from "zod";
import { SavedQueryError, type SavedQueryStore } from "./types.ts";

export interface SavedQueryStoreDeps {
  now: () => Date;
  randomId: () => string;
}

const rowSchema = z.object({
  id: z.string(),
  name: z.string(),
  target: z.string().nullable(),
  database: z.string().nullable(),
  sql: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

function toSaved(raw: unknown): SavedQuery {
  const row = rowSchema.parse(raw);
  return {
    id: row.id,
    name: row.name,
    target: row.target,
    database: row.database,
    sql: row.sql,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSavedQueryStore(db: Database, deps: SavedQueryStoreDeps): SavedQueryStore {
  function find(id: string): SavedQuery {
    const row = db.query("SELECT * FROM saved_queries WHERE id = ?").get(id);
    if (!row) throw new SavedQueryError("not_found", "No saved query with that id.");
    return toSaved(row);
  }

  function translateWriteError(error: unknown, name: string): never {
    if (error instanceof Error && error.message.includes("saved_queries.name")) {
      throw new SavedQueryError("name_taken", `A saved query named ${name} already exists.`);
    }
    throw error;
  }

  return {
    list() {
      return db
        .query("SELECT * FROM saved_queries ORDER BY name COLLATE NOCASE")
        .all()
        .map(toSaved);
    },

    create(input) {
      const id = deps.randomId();
      const now = deps.now().toISOString();
      try {
        db.run(
          `INSERT INTO saved_queries (id, name, target, database, sql, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, input.name, input.target, input.database, input.sql, now, now],
        );
      } catch (error) {
        translateWriteError(error, input.name);
      }
      return find(id);
    },

    update(id, patch) {
      const current = find(id);
      const next = { ...current, ...patch };
      try {
        db.run(
          `UPDATE saved_queries SET name = ?, target = ?, database = ?, sql = ?, updated_at = ?
           WHERE id = ?`,
          [next.name, next.target, next.database, next.sql, deps.now().toISOString(), id],
        );
      } catch (error) {
        translateWriteError(error, next.name);
      }
      return find(id);
    },

    remove(id) {
      const result = db.run("DELETE FROM saved_queries WHERE id = ?", [id]);
      if (result.changes === 0) {
        throw new SavedQueryError("not_found", "No saved query with that id.");
      }
    },
  };
}
