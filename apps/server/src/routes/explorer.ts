import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Explorer } from "../explorer/types.ts";
import { invalidRequest } from "./validation.ts";

const name = z.string().min(1).max(128);
const dbParam = z.object({ target: z.string(), db: name });
const objectsQuery = z.object({ schema: name.optional() });

/** Target ids are checked by Explorer.run, which answers target_not_found for bad ones. */
export function explorerRoutes(explorer: Explorer) {
  return new Hono()
    .get("/:target/info", async (c) =>
      c.json(await explorer.run(c.req.param("target"), (a) => a.info())),
    )
    .get("/:target/variables", async (c) =>
      c.json(await explorer.run(c.req.param("target"), (a) => a.variables())),
    )
    .get("/:target/databases", async (c) =>
      c.json(await explorer.run(c.req.param("target"), (a) => a.databases())),
    )
    .get("/:target/db/:db/schemas", zValidator("param", dbParam, invalidRequest), async (c) => {
      const { target, db } = c.req.valid("param");
      return c.json(await explorer.run(target, (a) => a.schemas(db)));
    })
    .get(
      "/:target/db/:db/objects",
      zValidator("param", dbParam, invalidRequest),
      zValidator("query", objectsQuery, invalidRequest),
      async (c) => {
        const { target, db } = c.req.valid("param");
        const schema = c.req.valid("query").schema ?? null;
        return c.json(await explorer.run(target, (a) => a.objects(db, schema)));
      },
    );
}
