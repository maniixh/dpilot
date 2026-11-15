export function targetHref(target: string): string {
  return `/c/${encodeURIComponent(target)}`;
}

export function databaseHref(target: string, db: string): string {
  return `${targetHref(target)}/db/${encodeURIComponent(db)}`;
}

export interface ExplorerPath {
  target: string;
  db: string | null;
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Reads `/c/<target>` or `/c/<target>/db/<db>` from the raw, still-encoded pathname.
 * wouter's params are decoded with decodeURI, which can't tell `%2F` in a name from `/`.
 */
export function parseExplorerPath(rawPath: string): ExplorerPath | null {
  const match = /^\/c\/([^/]+)(?:\/db\/([^/]+))?\/?$/.exec(rawPath);
  if (match === null) return null;
  const [, rawTarget, rawDb] = match;
  if (rawTarget === undefined) return null;
  const target = decode(rawTarget);
  const db = rawDb === undefined ? null : decode(rawDb);
  if (target === null || (rawDb !== undefined && db === null)) return null;
  return { target, db };
}
