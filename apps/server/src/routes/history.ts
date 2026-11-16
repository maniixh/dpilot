import { historyQuerySchema, savedQueryInputSchema, savedQueryPatchSchema } from "@dpilot/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { HistoryStore, SavedQueryStore } from "../store/types.ts";
import { invalidRequest } from "./validation.ts";

// Query strings arrive as text, so the numbers are coerced here rather than in the shared schema.
const historyListQuery = historyQuerySchema.extend({
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const historyClearQuery = historyQuerySchema.pick({ target: true });
const historyId = z.object({ id: z.coerce.number().int() });
const savedId = z.object({ id: z.uuid() });

export function historyRoutes(history: HistoryStore) {
  return new Hono()
    .get("/", zValidator("query", historyListQuery, invalidRequest), (c) =>
      c.json(history.list(c.req.valid("query"))),
    )
    .delete("/", zValidator("query", historyClearQuery, invalidRequest), (c) => {
      history.clear(c.req.valid("query").target ?? null);
      return c.body(null, 204);
    })
    .delete("/:id", zValidator("param", historyId, invalidRequest), (c) => {
      history.remove(c.req.valid("param").id);
      return c.body(null, 204);
    });
}

export function savedQueryRoutes(saved: SavedQueryStore) {
  return new Hono()
    .get("/", (c) => c.json(saved.list()))
    .post("/", zValidator("json", savedQueryInputSchema, invalidRequest), (c) =>
      c.json(saved.create(c.req.valid("json")), 201),
    )
    .patch(
      "/:id",
      zValidator("param", savedId, invalidRequest),
      zValidator("json", savedQueryPatchSchema, invalidRequest),
      (c) => c.json(saved.update(c.req.valid("param").id, c.req.valid("json"))),
    )
    .delete("/:id", zValidator("param", savedId, invalidRequest), (c) => {
      saved.remove(c.req.valid("param").id);
      return c.body(null, 204);
    });
}
