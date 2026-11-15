import {
  aggregateRequestSchema,
  countRequestSchema,
  deleteRequestSchema,
  insertRequestSchema,
  type RowKey,
  rowKeySchema,
  rowsQuerySchema,
  type TableRef,
  updateRequestSchema,
} from "@dpilot/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Explorer } from "../explorer/types.ts";
import { invalidRequest } from "./validation.ts";

export const MAX_CELL_BYTES = 16 * 1024 * 1024;

const name = z.string().min(1).max(128);
const dbParam = z.object({ target: z.string(), db: name });
const tableQuery = z.object({ schema: name.optional(), table: name });
const completionQuery = z.object({ schema: name.optional() });

const keyParam = z.string().transform((text, ctx): RowKey => {
  try {
    const parsed = rowKeySchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // Falls through to the issue below.
  }
  ctx.addIssue({ code: "custom", message: "key must be a JSON object of text values" });
  return z.NEVER;
});
const cellQuery = tableQuery.extend({ column: name, key: keyParam });

function refOf(query: { schema?: string | undefined; table: string }): TableRef {
  return { schema: query.schema ?? null, table: query.table };
}

/** Attachment names can't carry quotes, slashes or control characters. */
function attachmentName(column: string): string {
  return `${column.replace(/[^\w.-]/g, "_")}.bin`;
}

export function dataRoutes(explorer: Explorer) {
  return new Hono()
    .get(
      "/:target/db/:db/table",
      zValidator("param", dbParam, invalidRequest),
      zValidator("query", tableQuery, invalidRequest),
      async (c) => {
        const { target, db } = c.req.valid("param");
        const ref = refOf(c.req.valid("query"));
        return c.json(await explorer.data(target, (a) => a.table(db, ref)));
      },
    )
    .post(
      "/:target/db/:db/rows",
      zValidator("param", dbParam, invalidRequest),
      zValidator("json", rowsQuerySchema, invalidRequest),
      async (c) => {
        const { target, db } = c.req.valid("param");
        const query = c.req.valid("json");
        return c.json(await explorer.data(target, (a) => a.rows(db, query)));
      },
    )
    .post(
      "/:target/db/:db/rows/count",
      zValidator("param", dbParam, invalidRequest),
      zValidator("json", countRequestSchema, invalidRequest),
      async (c) => {
        const { target, db } = c.req.valid("param");
        const request = c.req.valid("json");
        return c.json({ count: await explorer.data(target, (a) => a.count(db, request)) });
      },
    )
    .post(
      "/:target/db/:db/rows/aggregate",
      zValidator("param", dbParam, invalidRequest),
      zValidator("json", aggregateRequestSchema, invalidRequest),
      async (c) => {
        const { target, db } = c.req.valid("param");
        const request = c.req.valid("json");
        return c.json(await explorer.data(target, (a) => a.aggregate(db, request)));
      },
    )
    .post(
      "/:target/db/:db/rows/insert",
      zValidator("param", dbParam, invalidRequest),
      zValidator("json", insertRequestSchema, invalidRequest),
      async (c) => {
        const { target, db } = c.req.valid("param");
        const request = c.req.valid("json");
        return c.json(await explorer.data(target, (a) => a.insert(db, request)));
      },
    )
    .post(
      "/:target/db/:db/rows/update",
      zValidator("param", dbParam, invalidRequest),
      zValidator("json", updateRequestSchema, invalidRequest),
      async (c) => {
        const { target, db } = c.req.valid("param");
        const request = c.req.valid("json");
        return c.json(await explorer.data(target, (a) => a.update(db, request)));
      },
    )
    .post(
      "/:target/db/:db/rows/delete",
      zValidator("param", dbParam, invalidRequest),
      zValidator("json", deleteRequestSchema, invalidRequest),
      async (c) => {
        const { target, db } = c.req.valid("param");
        const request = c.req.valid("json");
        return c.json(await explorer.data(target, (a) => a.remove(db, request)));
      },
    )
    .get(
      "/:target/db/:db/cell",
      zValidator("param", dbParam, invalidRequest),
      zValidator("query", cellQuery, invalidRequest),
      async (c) => {
        const { target, db } = c.req.valid("param");
        const { column, key, ...table } = c.req.valid("query");
        const ref = refOf(table);
        const bytes = await explorer.data(target, (a) => a.readCell(db, ref, key, column));
        return c.body(new Uint8Array(bytes), 200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${attachmentName(column)}"`,
          "Content-Length": String(bytes.byteLength),
        });
      },
    )
    .put(
      "/:target/db/:db/cell",
      zValidator("param", dbParam, invalidRequest),
      zValidator("query", cellQuery, invalidRequest),
      async (c) => {
        const { target, db } = c.req.valid("param");
        const { column, key, ...table } = c.req.valid("query");
        const ref = refOf(table);
        const tooLarge = () =>
          c.json({ error: "invalid_request", message: "Cells can be up to 16 MB." }, 413);
        const declared = Number(c.req.header("content-length") ?? 0);
        if (declared > MAX_CELL_BYTES) return tooLarge();
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        if (bytes.byteLength > MAX_CELL_BYTES) return tooLarge();
        return c.json(await explorer.data(target, (a) => a.writeCell(db, ref, key, column, bytes)));
      },
    )
    .get(
      "/:target/db/:db/completion",
      zValidator("param", dbParam, invalidRequest),
      zValidator("query", completionQuery, invalidRequest),
      async (c) => {
        const { target, db } = c.req.valid("param");
        const schema = c.req.valid("query").schema ?? null;
        return c.json({ tables: await explorer.data(target, (a) => a.completion(db, schema)) });
      },
    );
}
