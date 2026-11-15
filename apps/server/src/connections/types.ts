import type {
  ConnectionInput,
  ConnectionPatch,
  ConnectionTestRequest,
  EngineId,
  SavedConnection,
  TlsSettings,
} from "@dpilot/shared";

/** Everything needed to open a session against a server. */
export interface ConnectionConfig {
  engine: EngineId;
  host: string;
  port: number;
  username: string;
  password: string | null;
  database: string | null;
  tls: TlsSettings;
  readOnly: boolean;
}

export type ConnectionErrorCode =
  | "not_found"
  | "label_taken"
  | "password_required"
  | "password_lost"
  | "key_mismatch";

export class ConnectionError extends Error {
  override name = "ConnectionError";
  constructor(
    readonly code: ConnectionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ConnectionService {
  list(): Promise<SavedConnection[]>;
  get(id: string): Promise<SavedConnection>;
  create(input: ConnectionInput): Promise<SavedConnection>;
  update(id: string, patch: ConnectionPatch): Promise<SavedConnection>;
  remove(id: string): Promise<void>;
  /** The saved connection with its password decrypted. */
  resolve(id: string): Promise<ConnectionConfig>;
  /** A config for testing unsaved input, or a saved connection with unsaved changes. */
  draft(request: ConnectionTestRequest): Promise<ConnectionConfig>;
}
