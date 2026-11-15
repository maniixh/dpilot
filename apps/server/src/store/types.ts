import type {
  HistoryEntry,
  HistoryQuery,
  SavedQuery,
  SavedQueryInput,
  SavedQueryPatch,
} from "@dpilot/shared";

export interface Sealed {
  cipher: Uint8Array;
  iv: Uint8Array;
}

export interface SecretBox {
  seal(plain: string): Promise<Sealed>;
  /** Throws SecretBoxError when the data was not sealed with this key or was altered. */
  open(sealed: Sealed): Promise<string>;
}

export class SecretBoxError extends Error {
  constructor(message = "The data couldn't be decrypted with this key") {
    super(message);
    this.name = "SecretBoxError";
  }
}

export interface KeyStore {
  /** Null when no key exists yet; throws when one exists but is unusable. */
  read(): Uint8Array | null;
  /** Creates a new key; throws if one already exists. */
  create(): Uint8Array;
}

export interface HistoryStore {
  /** Stores the entry with its SQL redacted and truncated, then prunes the oldest rows. */
  add(entry: Omit<HistoryEntry, "id">): HistoryEntry;
  /** Newest first. */
  list(query: HistoryQuery): HistoryEntry[];
  remove(id: number): void;
  /** Clears one target's history, or everything when null. */
  clear(target: string | null): void;
}

export type SavedQueryErrorCode = "not_found" | "name_taken";

export class SavedQueryError extends Error {
  override name = "SavedQueryError";
  constructor(
    readonly code: SavedQueryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface SavedQueryStore {
  list(): SavedQuery[];
  create(input: SavedQueryInput): SavedQuery;
  update(id: string, patch: SavedQueryPatch): SavedQuery;
  remove(id: string): void;
}
