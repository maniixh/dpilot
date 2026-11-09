import { z } from "zod";

/** 32 random bytes, hex encoded. */
export const sessionTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const createSessionRequestSchema = z.object({ token: sessionTokenSchema }).strict();

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
