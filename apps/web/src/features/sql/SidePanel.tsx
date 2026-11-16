import type { HistoryEntry, SavedQuery } from "@dpilot/shared";
import { type FormEvent, useEffect, useId, useState } from "react";
import { ApiError } from "../../api/client.ts";
import {
  useClearHistory,
  useCreateSavedQuery,
  useHistory,
  useRemoveHistory,
  useRemoveSavedQuery,
  useSavedQueries,
  useUpdateSavedQuery,
} from "../../api/query.ts";
import { buttonClass } from "../../ui/button.ts";
import { inputClass } from "../../ui/form.tsx";
import { ErrorLine } from "../explorer/ServerOverview.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { formatDuration } from "./editor-model.ts";

const HISTORY_PAGE = 30;
const SEARCH_DELAY_MS = 300;
const PREVIEW_CHARS = 240;

export interface OpenQuery {
  sql: string;
  database: string | null;
  title: string | null;
}

interface SidePanelProps {
  target: string;
  /** The active tab, for saving it. */
  current: { sql: string; database: string | null };
  canOpen: boolean;
  onOpen: (query: OpenQuery) => void;
}

const SMALL_BUTTON = `${buttonClass.quiet} py-1`;

function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

function preview(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

function savedError(error: Error | null, name: string): string | null {
  if (error === null) return null;
  if (error instanceof ApiError && error.code === "name_taken") {
    return `A saved query named "${name}" already exists. Pick another name.`;
  }
  return error instanceof ApiError ? error.message : "Dpilot couldn't reach its server.";
}

export function SidePanel(props: SidePanelProps) {
  const [view, setView] = useState<"history" | "saved">("history");
  return (
    <section aria-label="History and saved queries" className="flex min-w-0 flex-col gap-3">
      <div role="tablist" aria-label="Side panel" className="flex gap-1 border-b border-rule">
        {(["history", "saved"] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`side-tab-${name}`}
            aria-selected={view === name}
            aria-controls={`side-panel-${name}`}
            onClick={() => setView(name)}
            className={`border-b-2 px-3 py-1.5 text-sm ${
              view === name ? "border-ink font-medium" : "border-transparent text-slate"
            }`}
          >
            {name === "history" ? "History" : "Saved"}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`side-panel-${view}`} aria-labelledby={`side-tab-${view}`}>
        {view === "history" ? <HistoryPanel {...props} /> : <SavedPanel {...props} />}
      </div>
    </section>
  );
}

function HistoryPanel({ target, canOpen, onOpen }: SidePanelProps) {
  const searchId = useId();
  const [text, setText] = useState("");
  const [cursors, setCursors] = useState<number[]>([]);
  const [clearing, setClearing] = useState(false);
  const search = useDebounced(text.trim(), SEARCH_DELAY_MS);
  const clear = useClearHistory();
  const remove = useRemoveHistory();

  useEffect(() => {
    setCursors([]);
  }, [search]);

  const pages: (number | undefined)[] = [undefined, ...cursors];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={searchId} className="text-sm font-medium">
          Search history
        </label>
        <input
          id={searchId}
          type="search"
          value={text}
          maxLength={200}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search SQL"
          className={`${inputClass} py-1.5`}
        />
      </div>
      {remove.isError && <ErrorLine error={remove.error} onRetry={() => remove.reset()} />}
      <ul className="flex flex-col divide-y divide-rule border-y border-rule">
        {pages.map((before, page) => (
          <HistoryPage
            key={before ?? "first"}
            target={target}
            search={search}
            before={before}
            isLast={page === pages.length - 1}
            canOpen={canOpen}
            onOpen={onOpen}
            onRemove={(id) => remove.mutate(id)}
            onMore={(id) => setCursors((current) => [...current, id])}
          />
        ))}
      </ul>
      <button
        type="button"
        onClick={() => setClearing(true)}
        className={`${SMALL_BUTTON} self-start`}
      >
        Clear history for this server
      </button>
      <ConfirmDialog
        open={clearing}
        title="Clear history?"
        confirmLabel="Clear history"
        busy={clear.isPending}
        error={clear.isError ? "Dpilot couldn't clear the history." : null}
        onCancel={() => setClearing(false)}
        onConfirm={() => clear.mutate(target, { onSuccess: () => setClearing(false) })}
      >
        <p className="text-slate">
          This removes every run Dpilot remembers for this server. Saved queries stay.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function HistoryPage(props: {
  target: string;
  search: string;
  before: number | undefined;
  isLast: boolean;
  canOpen: boolean;
  onOpen: (query: OpenQuery) => void;
  onRemove: (id: number) => void;
  onMore: (id: number) => void;
}) {
  const { target, search, before, isLast } = props;
  const history = useHistory({
    target,
    search: search === "" ? undefined : search,
    before,
    limit: HISTORY_PAGE,
  });
  if (history.data === undefined) {
    return (
      <li className="py-3 text-sm">
        {history.isPending ? (
          <span className="text-slate">Loading history…</span>
        ) : (
          <ErrorLine error={history.error} onRetry={() => void history.refetch()} />
        )}
      </li>
    );
  }
  const entries = history.data;
  const last = entries[entries.length - 1];
  return (
    <>
      {entries.length === 0 && before === undefined && (
        <li className="py-3 text-sm text-slate">
          {search === "" ? "Nothing has run on this server yet." : "No history matches."}
        </li>
      )}
      {entries.map((entry) => (
        <HistoryItem
          key={entry.id}
          entry={entry}
          canOpen={props.canOpen}
          onOpen={props.onOpen}
          onRemove={props.onRemove}
        />
      ))}
      {isLast && last !== undefined && entries.length >= HISTORY_PAGE && (
        <li className="py-2">
          <button type="button" onClick={() => props.onMore(last.id)} className={SMALL_BUTTON}>
            Load older
          </button>
        </li>
      )}
    </>
  );
}

const OUTCOME_LABEL: Record<HistoryEntry["outcome"], string> = {
  ok: "Succeeded",
  error: "Failed",
  cancelled: "Cancelled",
};

function HistoryItem(props: {
  entry: HistoryEntry;
  canOpen: boolean;
  onOpen: (query: OpenQuery) => void;
  onRemove: (id: number) => void;
}) {
  const { entry } = props;
  const when = new Date(entry.startedAt).toLocaleString();
  return (
    <li className="flex flex-col gap-1.5 py-3">
      <code className="font-mono text-xs break-words text-ink">{preview(entry.sql)}</code>
      <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-slate">
        <span className={entry.outcome === "error" ? "font-medium text-down" : undefined}>
          {OUTCOME_LABEL[entry.outcome]}
        </span>
        <span>{when}</span>
        <span>{formatDuration(entry.durationMs)}</span>
        {entry.database !== null && <span className="font-mono">{entry.database}</span>}
      </p>
      {entry.error !== null && <p className="text-xs break-words text-down">{entry.error}</p>}
      <div className="flex gap-3">
        <button
          type="button"
          disabled={!props.canOpen}
          title={props.canOpen ? undefined : "Close a tab first. The editor holds up to 10."}
          onClick={() => props.onOpen({ sql: entry.sql, database: entry.database, title: null })}
          className={SMALL_BUTTON}
        >
          Open in new tab
        </button>
        <button type="button" onClick={() => props.onRemove(entry.id)} className={SMALL_BUTTON}>
          Delete
        </button>
      </div>
    </li>
  );
}

function SavedPanel({ target, current, canOpen, onOpen }: SidePanelProps) {
  const nameId = useId();
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<SavedQuery | null>(null);
  const saved = useSavedQueries();
  const create = useCreateSavedQuery();
  const update = useUpdateSavedQuery();
  const remove = useRemoveSavedQuery();

  const mine = (saved.data ?? []).filter((q) => q.target === null || q.target === target);
  const blank = current.sql.trim() === "";

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "" || blank) return;
    create.mutate(
      { name: trimmed, target, database: current.database, sql: current.sql },
      { onSuccess: () => setName("") },
    );
  }

  function rename(event: FormEvent) {
    event.preventDefault();
    if (renaming === null || renaming.name.trim() === "") return;
    update.mutate(
      { id: renaming.id, patch: { name: renaming.name.trim() } },
      { onSuccess: () => setRenaming(null) },
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={submit} className="flex flex-col gap-1">
        <label htmlFor={nameId} className="text-sm font-medium">
          Save this tab as
        </label>
        <div className="flex gap-2">
          <input
            id={nameId}
            value={name}
            maxLength={100}
            onChange={(e) => {
              setName(e.target.value);
              create.reset();
            }}
            placeholder="Name"
            aria-invalid={create.isError}
            className={`${inputClass} min-w-0 py-1.5`}
          />
          <button
            type="submit"
            disabled={name.trim() === "" || blank || create.isPending}
            title={blank ? "Write some SQL first." : undefined}
            className={`${buttonClass.secondary} py-1.5`}
          >
            Save
          </button>
        </div>
        {create.isError && (
          <p role="alert" className="text-sm text-down">
            {savedError(create.error, name.trim())}
          </p>
        )}
      </form>

      {saved.data === undefined ? (
        saved.isPending ? (
          <p className="text-sm text-slate">Loading saved queries…</p>
        ) : (
          <ErrorLine error={saved.error} onRetry={() => void saved.refetch()} />
        )
      ) : mine.length === 0 ? (
        <p className="text-sm text-slate">No saved queries yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-rule border-y border-rule">
          {mine.map((query) => (
            <li key={query.id} className="flex flex-col gap-1.5 py-3">
              {renaming?.id === query.id ? (
                <form onSubmit={rename} className="flex flex-col gap-1">
                  <input
                    aria-label={`New name for ${query.name}`}
                    value={renaming.name}
                    maxLength={100}
                    // biome-ignore lint/a11y/noAutofocus: the field appears because the user asked to rename
                    autoFocus
                    onChange={(e) => {
                      setRenaming({ id: query.id, name: e.target.value });
                      update.reset();
                    }}
                    className={`${inputClass} py-1`}
                  />
                  {update.isError && (
                    <p role="alert" className="text-sm text-down">
                      {savedError(update.error, renaming.name.trim())}
                    </p>
                  )}
                  <div className="flex gap-3">
                    <button type="submit" disabled={update.isPending} className={SMALL_BUTTON}>
                      Save name
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRenaming(null);
                        update.reset();
                      }}
                      className={SMALL_BUTTON}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <p className="font-medium break-words">{query.name}</p>
              )}
              <code className="font-mono text-xs break-words text-slate">{preview(query.sql)}</code>
              <div className="flex flex-wrap gap-x-3">
                <button
                  type="button"
                  disabled={!canOpen}
                  title={canOpen ? undefined : "Close a tab first. The editor holds up to 10."}
                  onClick={() =>
                    onOpen({ sql: query.sql, database: query.database, title: query.name })
                  }
                  className={SMALL_BUTTON}
                >
                  Open in new tab
                </button>
                <button
                  type="button"
                  disabled={blank || update.isPending}
                  title="Replace the saved SQL with what this tab holds."
                  onClick={() =>
                    update.mutate({
                      id: query.id,
                      patch: { sql: current.sql, database: current.database },
                    })
                  }
                  className={SMALL_BUTTON}
                >
                  Update from this tab
                </button>
                <button
                  type="button"
                  onClick={() => {
                    update.reset();
                    setRenaming({ id: query.id, name: query.name });
                  }}
                  className={SMALL_BUTTON}
                >
                  Rename
                </button>
                <button type="button" onClick={() => setDeleting(query)} className={SMALL_BUTTON}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {update.isError && renaming === null && (
        <p role="alert" className="text-sm text-down">
          {savedError(update.error, "")}
        </p>
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete "${deleting?.name ?? ""}"?`}
        confirmLabel="Delete saved query"
        busy={remove.isPending}
        error={remove.isError ? "Dpilot couldn't delete this saved query." : null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting !== null) {
            remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) });
          }
        }}
      >
        <p className="text-slate">The query is removed for good. Tabs that hold its SQL keep it.</p>
      </ConfirmDialog>
    </div>
  );
}
