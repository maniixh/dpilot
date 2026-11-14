import {
  connectionInputSchema,
  connectionPatchSchema,
  connectionTestRequestSchema,
} from "@dpilot/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { ZodType } from "zod";
import type { ConnectionService } from "../connections/types.ts";
import type { Explorer } from "../explorer/types.ts";
import { invalidRequest } from "./validation.ts";

const json = <T extends ZodType>(schema: T) => zValidator("json", schema, invalidRequest);

export function connectionRoutes(connections: ConnectionService, explorer: Explorer) {
  return new Hono()
    .get("/", async (c) => c.json(await connections.list()))
    .post("/", json(connectionInputSchema), async (c) =>
      c.json(await connections.create(c.req.valid("json")), 201),
    )
    .post("/test", json(connectionTestRequestSchema), async (c) =>
      c.json(await explorer.test(c.req.valid("json"))),
    )
    .get("/:id", async (c) => c.json(await connections.get(c.req.param("id"))))
    .patch("/:id", json(connectionPatchSchema), async (c) =>
      c.json(await connections.update(c.req.param("id"), c.req.valid("json"))),
    )
    .delete("/:id", async (c) => {
      await connections.remove(c.req.param("id"));
      return c.body(null, 204);
    });
}
