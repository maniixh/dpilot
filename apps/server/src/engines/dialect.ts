import type {
  AggregateRequest,
  ColumnKind,
  ColumnMeta,
  CountRequest,
  Dialect,
  EditValue,
  Filter,
  RowKey,
  RowsQuery,
  TableMeta,
  TableRef,
} from "@dpilot/shared";
import { DataError } from "./types.ts";

export type SqlParam = string | number | null;

export interface BuiltQuery {
  text: string;
  params: SqlParam[];
}

/** Kinds the driver returns losslessly; everything else is read back as database text. */
const NATIVE_KINDS: readonly ColumnKind[] = ["text", "integer", "float", "boolean", "binary"];
const NUMERIC_KINDS: readonly ColumnKind[] = ["integer", "decimal", "float"];
const SEARCH_ESCAPE = { mysql: "ESCAPE '\\\\'", postgres: "ESCAPE '\\'" } as const;

export function quoteIdent(dialect: Dialect, name: string): string {
  const quote = dialect === "mysql" ? "`" : '"';
  return `${quote}${name.replaceAll(quote, quote + quote)}${quote}`;
}

export function qualified(dialect: Dialect, ref: TableRef): string {
  const table = quoteIdent(dialect, ref.table);
  return ref.schema === null ? table : `${quoteIdent(dialect, ref.schema)}.${table}`;
}

function invalid(message: string): DataError {
  return new DataError("invalid_request", message);
}

/** Catalog type text without length/precision modifiers, which would truncate in a cast. */
export function postgresCastType(type: string): string {
  return type.replace(/\([^)]*\)/g, "");
}

/** Numbers placeholders and keeps parameter order in step with the text. */
class Params<V = SqlParam> {
  readonly values: (SqlParam | V)[] = [];
  constructor(private readonly dialect: Dialect) {}

  /** `castTo` is a catalog type text; only Postgres needs it. */
  add(value: SqlParam | V, castTo: string | null = null): string {
    this.values.push(value);
    if (this.dialect === "mysql") return "?";
    const placeholder = `$${this.values.length}`;
    return castTo === null ? placeholder : `${placeholder}::${postgresCastType(castTo)}`;
  }
}

function findColumn(meta: TableMeta, name: string): ColumnMeta {
  const found = meta.columns.find((column) => column.name === name);
  if (!found) throw invalid(`No column named ${name}.`);
  return found;
}

function asText(dialect: Dialect, expression: string): string {
  return dialect === "mysql" ? `CAST(${expression} AS CHAR)` : `${expression}::text`;
}

function readExpression(dialect: Dialect, column: ColumnMeta): string {
  const quoted = quoteIdent(dialect, column.name);
  return NATIVE_KINDS.includes(column.kind) ? quoted : `${asText(dialect, quoted)} AS ${quoted}`;
}

function keyAlias(dialect: Dialect, index: number): string {
  return quoteIdent(dialect, `__k${index}`);
}

function selectList(dialect: Dialect, meta: TableMeta): string {
  const items = meta.columns.map((column) => readExpression(dialect, column));
  if (meta.editable) {
    meta.primaryKey.forEach((name, index) => {
      const quoted = quoteIdent(dialect, findColumn(meta, name).name);
      items.push(`${asText(dialect, quoted)} AS ${keyAlias(dialect, index)}`);
    });
  }
  return items.join(", ");
}

const COMPARISONS = { eq: "=", ne: "<>", lt: "<", le: "<=", gt: ">", ge: ">=" } as const;

function filterClause(dialect: Dialect, meta: TableMeta, filter: Filter, params: Params): string {
  const column = findColumn(meta, filter.column);
  const quoted = quoteIdent(dialect, column.name);
  if (filter.op === "is_null") return `${quoted} IS NULL`;
  if (filter.op === "not_null") return `${quoted} IS NOT NULL`;
  if (column.kind === "binary") throw invalid(`Can't filter binary column ${column.name}.`);
  const isList = filter.op === "in" || filter.op === "not_in";
  if (filter.op === "like" || filter.op === "not_like") {
    const subject = column.kind === "text" ? quoted : asText(dialect, quoted);
    return `${subject} ${filter.op === "like" ? "LIKE" : "NOT LIKE"} ${params.add(filter.value)}`;
  }
  const textCompared =
    dialect === "postgres" && (column.kind === "json" || column.kind === "other");
  const subject = textCompared ? asText(dialect, quoted) : quoted;
  const bind = (value: string): string => {
    if (textCompared) return params.add(value);
    return dialect === "mysql"
      ? mysqlKeyPlaceholder(column, value, params)
      : params.add(value, column.type);
  };
  if (isList) {
    const marks = filter.values.map(bind);
    return `${subject} ${filter.op === "in" ? "IN" : "NOT IN"} (${marks.join(", ")})`;
  }
  return `${subject} ${COMPARISONS[filter.op]} ${bind(filter.value)}`;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function searchClause(dialect: Dialect, meta: TableMeta, term: string, params: Params): string {
  const columns = meta.columns.filter((column) => column.kind === "text");
  if (columns.length === 0) return "1 = 0";
  const operator = dialect === "mysql" ? "LIKE" : "ILIKE";
  const pattern = `%${escapeLike(term)}%`;
  const parts = columns.map(
    (column) =>
      `${quoteIdent(dialect, column.name)} ${operator} ${params.add(pattern)} ${SEARCH_ESCAPE[dialect]}`,
  );
  return `(${parts.join(" OR ")})`;
}

function whereClause(
  dialect: Dialect,
  meta: TableMeta,
  request: CountRequest,
  params: Params,
): string {
  const parts = request.filters.map((filter) => filterClause(dialect, meta, filter, params));
  if (request.search !== null && request.search !== "") {
    parts.push(searchClause(dialect, meta, request.search, params));
  }
  return parts.length === 0 ? "" : ` WHERE ${parts.join(" AND ")}`;
}

function orderClause(dialect: Dialect, meta: TableMeta, query: RowsQuery): string {
  const terms =
    query.sort.length > 0
      ? query.sort.map((sort) => {
          const column = findColumn(meta, sort.column);
          return `${quoteIdent(dialect, column.name)} ${sort.direction === "desc" ? "DESC" : "ASC"}`;
        })
      : meta.primaryKey.map((name) => quoteIdent(dialect, name));
  return terms.length === 0 ? "" : ` ORDER BY ${terms.join(", ")}`;
}

export function selectPage(
  dialect: Dialect,
  meta: TableMeta,
  ref: TableRef,
  query: RowsQuery,
): BuiltQuery {
  const params = new Params(dialect);
  const where = whereClause(dialect, meta, query, params);
  const order = orderClause(dialect, meta, query);
  const limit = params.add(query.limit);
  const offset = params.add(query.offset);
  const text = `SELECT ${selectList(dialect, meta)} FROM ${qualified(dialect, ref)}${where}${order} LIMIT ${limit} OFFSET ${offset}`;
  return { text, params: params.values };
}

export function countRows(
  dialect: Dialect,
  meta: TableMeta,
  ref: TableRef,
  request: CountRequest,
): BuiltQuery {
  const params = new Params(dialect);
  const where = whereClause(dialect, meta, request, params);
  return {
    text: `SELECT COUNT(*) FROM ${qualified(dialect, ref)}${where}`,
    params: params.values,
  };
}

function aggregateExpression(
  dialect: Dialect,
  meta: TableMeta,
  { fn, column }: AggregateRequest["aggregates"][number],
): string {
  if (column === null) return "COUNT(*)";
  const found = findColumn(meta, column);
  const call = `${fn.toUpperCase()}(${quoteIdent(dialect, found.name)})`;
  if (fn === "count") return call;
  if (found.kind === "binary") throw invalid(`Can't ${fn} binary column ${column}.`);
  if (fn === "sum" || fn === "avg") {
    if (!NUMERIC_KINDS.includes(found.kind)) throw invalid(`Can't ${fn} column ${column}.`);
    return call;
  }
  return NATIVE_KINDS.includes(found.kind) ? call : asText(dialect, call);
}

export function aggregate(
  dialect: Dialect,
  meta: TableMeta,
  ref: TableRef,
  request: AggregateRequest,
): BuiltQuery {
  const params = new Params(dialect);
  const list = request.aggregates.map((item) => aggregateExpression(dialect, meta, item));
  const where = whereClause(dialect, meta, request, params);
  return {
    text: `SELECT ${list.join(", ")} FROM ${qualified(dialect, ref)}${where}`,
    params: params.values,
  };
}

function assignedColumn(meta: TableMeta, name: string): ColumnMeta {
  const column = findColumn(meta, name);
  if (column.kind === "binary") {
    throw invalid(`Binary column ${name} can only be changed by uploading a file.`);
  }
  return column;
}

/** MySQL compares text to numbers as doubles, which would blur 64-bit keys; cast exactly. */
function mysqlKeyPlaceholder<V>(column: ColumnMeta, value: string, params: Params<V>): string {
  if (column.kind === "integer") {
    const target = /\bunsigned\b/i.test(column.type) ? "UNSIGNED" : "SIGNED";
    return `CAST(${params.add(value)} AS ${target})`;
  }
  if (column.kind === "decimal") return `CAST(${params.add(value)} AS DECIMAL(65,30))`;
  return params.add(value);
}

function keyPredicate<V>(
  dialect: Dialect,
  meta: TableMeta,
  key: RowKey,
  params: Params<V>,
): string {
  const names = Object.keys(key);
  const exact =
    meta.primaryKey.length > 0 &&
    names.length === meta.primaryKey.length &&
    meta.primaryKey.every((name) => Object.hasOwn(key, name));
  if (!exact) throw invalid("The key must name exactly the primary key columns.");
  const terms = meta.primaryKey.map((name) => {
    const column = findColumn(meta, name);
    const quoted = quoteIdent(dialect, column.name);
    const value = key[name] ?? "";
    if (dialect === "postgres") return `${quoted} = ${params.add(value, column.type)}`;
    return `${quoted} = ${mysqlKeyPlaceholder(column, value, params)}`;
  });
  return terms.join(" AND ");
}

function assignedValue(column: ColumnMeta, value: EditValue, params: Params): string {
  return "useDefault" in value ? "DEFAULT" : params.add(value.set, column.type);
}

export function insertRow(
  dialect: Dialect,
  meta: TableMeta,
  ref: TableRef,
  values: Record<string, EditValue>,
): BuiltQuery {
  const params = new Params(dialect);
  const target = qualified(dialect, ref);
  const entries = Object.entries(values);
  if (entries.length === 0) {
    const empty = dialect === "mysql" ? "() VALUES ()" : "DEFAULT VALUES";
    return { text: `INSERT INTO ${target} ${empty}`, params: [] };
  }
  const names = entries.map(([name]) => quoteIdent(dialect, assignedColumn(meta, name).name));
  const marks = entries.map(([name, value]) =>
    assignedValue(assignedColumn(meta, name), value, params),
  );
  return {
    text: `INSERT INTO ${target} (${names.join(", ")}) VALUES (${marks.join(", ")})`,
    params: params.values,
  };
}

export function lockRow(dialect: Dialect, meta: TableMeta, ref: TableRef, key: RowKey): BuiltQuery {
  const params = new Params(dialect);
  const where = keyPredicate(dialect, meta, key, params);
  return {
    text: `SELECT 1 FROM ${qualified(dialect, ref)} WHERE ${where} FOR UPDATE`,
    params: params.values,
  };
}

export function updateRow(
  dialect: Dialect,
  meta: TableMeta,
  ref: TableRef,
  key: RowKey,
  values: Record<string, EditValue>,
): BuiltQuery {
  const entries = Object.entries(values);
  if (entries.length === 0) throw invalid("Nothing to update.");
  const params = new Params(dialect);
  const assignments = entries.map(([name, value]) => {
    const column = assignedColumn(meta, name);
    return `${quoteIdent(dialect, column.name)} = ${assignedValue(column, value, params)}`;
  });
  const where = keyPredicate(dialect, meta, key, params);
  return {
    text: `UPDATE ${qualified(dialect, ref)} SET ${assignments.join(", ")} WHERE ${where}`,
    params: params.values,
  };
}

/** One cell as the database would write it as text; text and binary stay native. */
export function selectCell(
  dialect: Dialect,
  meta: TableMeta,
  ref: TableRef,
  key: RowKey,
  columnName: string,
): BuiltQuery {
  const params = new Params(dialect);
  const column = findColumn(meta, columnName);
  const quoted = quoteIdent(dialect, column.name);
  const expression =
    column.kind === "text" || column.kind === "binary" ? quoted : asText(dialect, quoted);
  const where = keyPredicate(dialect, meta, key, params);
  return {
    text: `SELECT ${expression} FROM ${qualified(dialect, ref)} WHERE ${where}`,
    params: params.values,
  };
}

export interface BuiltCellWrite {
  text: string;
  params: (SqlParam | Uint8Array)[];
}

export function updateCell(
  dialect: Dialect,
  meta: TableMeta,
  ref: TableRef,
  key: RowKey,
  columnName: string,
  bytes: Uint8Array,
): BuiltCellWrite {
  const column = findColumn(meta, columnName);
  if (column.kind !== "binary") throw invalid(`Column ${columnName} isn't a binary column.`);
  const params = new Params<Uint8Array>(dialect);
  const value = params.add(bytes, column.type);
  const where = keyPredicate(dialect, meta, key, params);
  return {
    text: `UPDATE ${qualified(dialect, ref)} SET ${quoteIdent(dialect, column.name)} = ${value} WHERE ${where}`,
    params: params.values,
  };
}

export function deleteRow(
  dialect: Dialect,
  meta: TableMeta,
  ref: TableRef,
  key: RowKey,
): BuiltQuery {
  const params = new Params(dialect);
  const where = keyPredicate(dialect, meta, key, params);
  return { text: `DELETE FROM ${qualified(dialect, ref)} WHERE ${where}`, params: params.values };
}
