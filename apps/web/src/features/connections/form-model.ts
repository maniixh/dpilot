import {
  type ConnectionInput,
  type ConnectionPatch,
  connectionInputSchema,
  connectionPatchSchema,
  type EngineId,
  getEngine,
  type SavedConnection,
  type TlsMode,
  type TlsSettings,
} from "@dpilot/shared";

/** The connection form's raw field values, as typed. */
export interface FormValues {
  label: string;
  engine: EngineId;
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  tlsMode: TlsMode;
  ca: string;
  /** Editing only: remove the saved password instead of keeping it. */
  clearPassword: boolean;
  readOnly: boolean;
}

export function emptyForm(engine: EngineId): FormValues {
  const info = getEngine(engine);
  return {
    label: "",
    engine,
    host: "127.0.0.1",
    port: String(info.defaultPort),
    username: info.defaultUser,
    password: "",
    database: "",
    tlsMode: "off",
    ca: "",
    clearPassword: false,
    readOnly: false,
  };
}

export function fromSaved(saved: SavedConnection): FormValues {
  return {
    label: saved.label,
    engine: saved.engine,
    host: saved.host,
    port: String(saved.port),
    username: saved.username,
    password: "",
    database: saved.database ?? "",
    tlsMode: saved.tls.mode,
    ca: saved.tls.ca ?? "",
    clearPassword: false,
    readOnly: saved.readOnly,
  };
}

/** Changes engine, replacing the port and user only where they are still the old defaults. */
export function switchEngine(values: FormValues, engine: EngineId): FormValues {
  const previous = getEngine(values.engine);
  const next = getEngine(engine);
  return {
    ...values,
    engine,
    port: values.port === String(previous.defaultPort) ? String(next.defaultPort) : values.port,
    username: values.username === previous.defaultUser ? next.defaultUser : values.username,
  };
}

function parsePort(port: string): number {
  return port.trim() === "" ? Number.NaN : Number(port);
}

function databaseOf(values: FormValues): string | null {
  const database = values.database.trim();
  return database === "" ? null : database;
}

function tlsOf(values: FormValues): TlsSettings {
  return { mode: values.tlsMode, ca: values.tlsMode === "verify" ? values.ca : null };
}

/** Builds the create request. Invalid values pass through for the schema to reject. */
export function toInput(values: FormValues): ConnectionInput {
  return {
    label: values.label.trim(),
    engine: values.engine,
    host: values.host.trim(),
    port: parsePort(values.port),
    username: values.username,
    password: values.password === "" ? null : values.password,
    database: databaseOf(values),
    tls: tlsOf(values),
    readOnly: values.readOnly,
  };
}

/** Builds an update with only the fields that differ from the saved connection. */
export function toPatch(values: FormValues, saved: SavedConnection): ConnectionPatch {
  const input = toInput(values);
  const patch: ConnectionPatch = {};
  if (input.label !== saved.label) patch.label = input.label;
  if (input.engine !== saved.engine) patch.engine = input.engine;
  if (input.host !== saved.host) patch.host = input.host;
  if (input.port !== saved.port) patch.port = input.port;
  if (input.username !== saved.username) patch.username = input.username;
  if (input.password !== null) patch.password = input.password;
  else if (values.clearPassword && (saved.hasPassword || saved.passwordLost)) patch.password = null;
  if (input.database !== saved.database) patch.database = input.database;
  if (input.tls.mode !== saved.tls.mode || input.tls.ca !== saved.tls.ca) patch.tls = input.tls;
  if (input.readOnly !== saved.readOnly) patch.readOnly = input.readOnly;
  return patch;
}

/** Mirrors the server: a saved password isn't sent to a different server. */
export function needsPassword(values: FormValues, saved: SavedConnection): boolean {
  if (values.password !== "" || values.clearPassword) return false;
  if (!(saved.hasPassword || saved.passwordLost)) return false;
  return (
    values.engine !== saved.engine ||
    values.host.trim() !== saved.host ||
    parsePort(values.port) !== saved.port
  );
}

export type FormField = "label" | "host" | "port" | "username" | "password" | "database" | "ca";

function fieldOf(path: readonly PropertyKey[]): FormField | null {
  const [first, second] = path;
  if (first === "tls") return second === "ca" ? "ca" : null;
  if (first === "engine") return null;
  return typeof first === "string" ? (first as FormField) : null;
}

/** Fields the shared schema rejects: the whole input when adding, only the changes when editing. */
export function invalidFields(
  values: FormValues,
  saved: SavedConnection | null,
): ReadonlySet<FormField> {
  const result =
    saved === null
      ? connectionInputSchema.safeParse(toInput(values))
      : connectionPatchSchema.safeParse(toPatch(values, saved));
  if (result.success) return new Set();
  const fields = result.error.issues.map((issue) => fieldOf(issue.path));
  return new Set(fields.filter((field): field is FormField => field !== null));
}
