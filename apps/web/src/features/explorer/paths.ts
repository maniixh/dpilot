export function targetHref(target: string): string {
  return `/c/${encodeURIComponent(target)}`;
}

export function databaseHref(target: string, db: string): string {
  return `${targetHref(target)}/db/${encodeURIComponent(db)}`;
}

export function tableHref(
  target: string,
  db: string,
  schema: string | null,
  table: string,
): string {
  const scope = schema === null ? "" : `/schema/${encodeURIComponent(schema)}`;
  return `${databaseHref(target, db)}${scope}/table/${encodeURIComponent(table)}`;
}

export function editorHref(target: string, db: string | null): string {
  return `${db === null ? targetHref(target) : databaseHref(target, db)}/query`;
}

export type ExplorerPath =
  | { kind: "target"; target: string }
  | { kind: "database"; target: string; db: string }
  | { kind: "table"; target: string; db: string; schema: string | null; table: string }
  | { kind: "editor"; target: string; db: string | null };

const TARGET_PATH = /^\/c\/([^/]+)\/?$/;
const DATABASE_PATH = /^\/c\/([^/]+)\/db\/([^/]+)\/?$/;
const TABLE_PATH = /^\/c\/([^/]+)\/db\/([^/]+)(?:\/schema\/([^/]+))?\/table\/([^/]+)\/?$/;
const EDITOR_PATH = /^\/c\/([^/]+)(?:\/db\/([^/]+))?\/query\/?$/;

/** Decodes the captured segments; undefined groups stay null, a broken escape gives undefined. */
function decodeGroups(match: RegExpExecArray): (string | null)[] | undefined {
  const values: (string | null)[] = [];
  for (const raw of match.slice(1)) {
    if (raw === undefined) {
      values.push(null);
      continue;
    }
    try {
      values.push(decodeURIComponent(raw));
    } catch {
      return undefined;
    }
  }
  return values;
}

/**
 * Reads the explorer, grid and editor paths from the raw, still-encoded pathname.
 * wouter's params are decoded with decodeURI, which can't tell `%2F` in a name from `/`.
 */
export function parseExplorerPath(rawPath: string): ExplorerPath | null {
  const table = TABLE_PATH.exec(rawPath);
  if (table !== null) {
    const groups = decodeGroups(table);
    const [target, db, schema, name] = groups ?? [];
    if (target == null || db == null || name == null) return null;
    return { kind: "table", target, db, schema: schema ?? null, table: name };
  }
  const editor = EDITOR_PATH.exec(rawPath);
  if (editor !== null) {
    const [target, db] = decodeGroups(editor) ?? [];
    return target == null ? null : { kind: "editor", target, db: db ?? null };
  }
  const database = DATABASE_PATH.exec(rawPath);
  if (database !== null) {
    const [target, db] = decodeGroups(database) ?? [];
    return target == null || db == null ? null : { kind: "database", target, db };
  }
  const targetOnly = TARGET_PATH.exec(rawPath);
  if (targetOnly === null) return null;
  const [target] = decodeGroups(targetOnly) ?? [];
  return target == null ? null : { kind: "target", target };
}
