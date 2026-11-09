import { sessionTokenSchema } from "@dpilot/shared";

export interface TokenFromUrl {
  /** Null when the URL carried a token parameter that is not a valid session token. */
  token: string | null;
  /** Path, query and hash with the token removed, for history.replaceState. */
  cleanUrl: string;
}

export function takeTokenFromUrl(href: string): TokenFromUrl | null {
  const url = new URL(href);
  const raw = url.searchParams.get("token");
  if (raw === null) return null;

  url.searchParams.delete("token");
  const parsed = sessionTokenSchema.safeParse(raw);
  return {
    token: parsed.success ? parsed.data : null,
    cleanUrl: `${url.pathname}${url.search}${url.hash}`,
  };
}
