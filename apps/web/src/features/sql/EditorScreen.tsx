import { dialectOf, type EngineId, getEngine, type QueryRequest } from "@dpilot/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Link } from "wouter";
import { ApiError } from "../../api/client.ts";
import { useConnections } from "../../api/connections.ts";
import { useCompletion } from "../../api/data.ts";
import { useDatabases } from "../../api/explorer.ts";
import { queryKeys, queryRequests } from "../../api/query.ts";
import { buttonClass } from "../../ui/button.ts";
import { inputClass } from "../../ui/form.tsx";
import { useMediaQuery } from "../../ui/use-media-query.ts";
import { databaseHref, targetHref } from "../explorer/paths.ts";
import { ErrorLine, useTarget } from "../explorer/ServerOverview.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import {
  beginRun,
  buildRunRequest,
  confirmedRequest,
  declineConfirmation,
  explainStatement,
  failRun,
  isBusy,
  markCancelling,
  planFileRun,
  type RunPhase,
  type RunSource,
  runTarget,
  settleRun,
} from "./editor-model.ts";
import { Results } from "./Results.tsx";
import { type OpenQuery, SidePanel } from "./SidePanel.tsx";
import { type EditorRange, SqlEditor, type SqlEditorHandle } from "./SqlEditor.tsx";
import {
  addTab,
  closeTab,
  createTab,
  loadTabs,
  MAX_TABS,
  renameTab,
  saveTabs,
  type Tab,
  updateTab,
} from "./tabs-model.ts";

const ROW_LIMITS = [100, 1000, 5000, 10_000] as const;
const SAVE_DELAY_MS = 400;
const NO_SCHEMA: Record<string, string[]> = {};
const IDLE: RunPhase = { phase: "idle" };

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";
const SHORTCUT_HINT = `${MOD}+Enter runs the statement at the cursor, ${MOD}+Shift+Enter runs everything, Esc cancels.`;

export function EditorScreen({ target, db }: { target: string; db: string | null }) {
  const state = useTarget(target);
  const summary = state.status === "found" ? state.summary : undefined;
  const label = summary?.label ?? target;

  return (
    <div className="flex flex-col gap-5">
      <header>
        <Link
          href={db === null ? targetHref(target) : databaseHref(target, db)}
          className={buttonClass.quiet}
        >
          {db === null ? `Back to ${label}` : `Back to ${db}`}
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">SQL editor</h1>
        <p className="mt-1 text-slate">
          {summary === undefined ? label : `${getEngine(summary.engine).label} on ${label}`}
        </p>
      </header>
      {state.status === "loading" ? (
        <p className="text-slate">Loading…</p>
      ) : state.status === "error" ? (
        <ErrorLine error={state.error} onRetry={state.retry} />
      ) : state.status === "unavailable" ? (
        <p role="alert" className="border-l-2 border-down pl-4">
          {state.message}
        </p>
      ) : state.status === "missing" ? (
        <p role="alert" className="border-l-2 border-down pl-4">
          Dpilot doesn't know this server. It may have been removed.
        </p>
      ) : (
        <Workspace target={target} db={db} engine={state.summary.engine} />
      )}
    </div>
  );
}

type Notice = { tone: "info" | "error"; text: string };

function initialTabs(target: string, db: string | null): Tab[] {
  const tabs = loadTabs(localStorage, target, db);
  const first = tabs[0];
  return db !== null && first !== undefined ? updateTab(tabs, first.id, { database: db }) : tabs;
}

function Workspace(props: { target: string; db: string | null; engine: EngineId }) {
  const { target, db } = props;
  const dialect = dialectOf(props.engine);
  const client = useQueryClient();
  const [tabs, setTabs] = useState(() => initialTabs(target, db));
  const [activeId, setActiveId] = useState(() => tabs[0]?.id ?? "");
  const [phases, setPhases] = useState<Record<string, RunPhase>>({});
  const [maxRows, setMaxRows] = useState<number>(1000);
  const [highlight, setHighlight] = useState<EditorRange | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const editor = useRef<SqlEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const databaseId = useId();
  const limitId = useId();
  const wide = useMediaQuery("(min-width: 1280px)");

  const tab = tabs.find((t) => t.id === activeId) ?? (tabs[0] as Tab);
  const phase = phases[tab.id] ?? IDLE;
  const busy = isBusy(phase);
  const connections = useConnections(target.startsWith("c."));
  const readOnly = (connections.data ?? []).some(
    (saved) => `c.${saved.id}` === target && saved.readOnly,
  );
  const databases = useDatabases(target, true);
  const completion = useCompletion(target, tab.database ?? "", null, tab.database !== null);

  const latestTabs = useRef(tabs);
  latestTabs.current = tabs;
  useEffect(() => {
    const timer = setTimeout(
      () => setStorageFailed(!saveTabs(localStorage, target, tabs)),
      SAVE_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [tabs, target]);
  useEffect(
    () => () => {
      saveTabs(localStorage, target, latestTabs.current);
    },
    [target],
  );

  const setPhase = useCallback((id: string, change: (current: RunPhase) => RunPhase) => {
    // A tab closed mid-run has no entry, so its late result is dropped.
    setPhases((all) => {
      const current = all[id];
      return current === undefined ? all : { ...all, [id]: change(current) };
    });
  }, []);

  async function execute(id: string, request: QueryRequest) {
    try {
      const result = await queryRequests.run(target, request);
      setPhase(id, (current) => settleRun(current, result));
    } catch (error) {
      setPhase(id, (current) =>
        failRun(current, error instanceof Error ? error : new Error(String(error))),
      );
    } finally {
      void client.invalidateQueries({ queryKey: queryKeys.history });
    }
  }

  function start(forTab: Tab, source: RunSource) {
    const current = phases[forTab.id] ?? IDLE;
    if (isBusy(current)) return;
    setNotice(null);
    if (source.sql.trim() === "") {
      const message = "There's nothing to run. Write a statement first.";
      setPhases((all) => ({ ...all, [forTab.id]: { phase: "failed", message } }));
      return;
    }
    const request = buildRunRequest({
      runId: crypto.randomUUID(),
      tab: forTab.id,
      sql: source.sql,
      database: forTab.database,
      maxRows,
      confirmed: false,
    });
    setPhases((all) => ({ ...all, [forTab.id]: beginRun(current, request, source) }));
    void execute(forTab.id, request);
  }

  function run(mode: "selection" | "all") {
    const handle = editor.current;
    if (handle === null) return;
    start(tab, runTarget(handle.doc(), handle.selection(), dialect, mode));
  }

  function explain() {
    const handle = editor.current;
    if (handle === null) return;
    const source = runTarget(handle.doc(), handle.selection(), dialect, "selection");
    start(tab, explainStatement(source, dialect));
  }

  async function cancel(): Promise<void> {
    if (phase.phase !== "running") return;
    const { runId } = phase.request;
    setPhase(tab.id, markCancelling);
    try {
      await queryRequests.cancel(target, runId);
    } catch (error) {
      // 404 means the run finished before the cancel arrived, which is what was wanted.
      if (error instanceof ApiError && error.code === "run_not_found") return;
      setNotice({ tone: "error", text: "Dpilot couldn't cancel this run. Try Cancel again." });
    }
  }

  function onCancelKey(): boolean {
    if (!busy) return false;
    void cancel();
    return true;
  }

  function onWorkspaceKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented) return;
    if (event.key === "Escape" && busy) {
      event.preventDefault();
      void cancel();
    } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      run(event.shiftKey ? "all" : "selection");
    }
  }

  function confirmRun() {
    if (phase.phase !== "confirm") return;
    const request = confirmedRequest(phase, crypto.randomUUID());
    if (request === null) return;
    setPhases((all) => ({ ...all, [tab.id]: beginRun(phase, request, phase.source) }));
    void execute(tab.id, request);
  }

  function openTab(query: OpenQuery): Tab | null {
    const created = createTab(query.database ?? tab.database, tabs, query.sql);
    const opened = query.title === null ? created : { ...created, title: query.title };
    const next = addTab(tabs, opened);
    if (next === null) {
      const text = `The editor holds up to ${MAX_TABS} tabs. Close one first.`;
      setNotice({ tone: "error", text });
      return null;
    }
    setTabs(next);
    setActiveId(opened.id);
    return opened;
  }

  function closeTabById(id: string) {
    const next = closeTab(tabs, id);
    if (id === activeId) {
      const at = Math.min(
        tabs.findIndex((t) => t.id === id),
        next.length - 1,
      );
      setActiveId(next[at]?.id ?? "");
    }
    setTabs(next);
    setPhases(({ [id]: _closed, ...rest }) => rest);
    // The server also closes idle sessions, so a failed cleanup needs no answer here.
    void queryRequests.closeTab(target, id).catch(() => undefined);
  }

  async function onFileChosen(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    const plan = planFileRun(file.size, tabs.length);
    if (plan.kind === "reject") {
      setNotice({ tone: "error", text: plan.message });
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setNotice({ tone: "error", text: `Dpilot couldn't read ${file.name}.` });
      return;
    }
    if (plan.kind === "tab") {
      const opened = openTab({ sql: text, database: tab.database, title: file.name });
      if (opened !== null) start(opened, { sql: text, offset: 0 });
      return;
    }
    start(tab, { sql: text, offset: 0 });
    const size = (file.size / (1024 * 1024)).toFixed(1);
    setNotice({
      tone: "info",
      text: `Ran ${file.name} (${size} MB) without loading it into the editor.`,
    });
  }

  const highlightable = useCallback(
    (source: RunSource) =>
      editor.current?.doc().slice(source.offset, source.offset + source.sql.length) === source.sql,
    [],
  );

  const side = (
    <SidePanel
      target={target}
      current={{ sql: tab.sql, database: tab.database }}
      canOpen={tabs.length < MAX_TABS}
      onOpen={openTab}
    />
  );
  const userDatabases = (databases.data ?? []).filter((d) => d.browsable && !d.system);
  const systemDatabases = (databases.data ?? []).filter((d) => d.browsable && d.system);
  const known = new Set((databases.data ?? []).map((d) => d.name));

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: shortcuts bubble up from the editor and toolbar
    <div className="flex flex-col gap-4" onKeyDown={onWorkspaceKeyDown}>
      {readOnly && (
        <p role="status" className="border-l-2 border-flag pl-4">
          <span className="font-medium">Read-only connection.</span> Dpilot runs only SELECT-style
          statements here, each in a transaction it rolls back. That is a guard rail against
          mistakes, not protection. For real protection, connect with a database user that can only
          read.
        </p>
      )}

      <div role="tablist" aria-label="Editor tabs" className="flex flex-wrap items-end gap-1">
        {tabs.map((t) => (
          <TabButton
            key={t.id}
            tab={t}
            active={t.id === tab.id}
            running={isBusy(phases[t.id] ?? IDLE)}
            renaming={renaming?.id === t.id ? renaming.title : null}
            onSelect={() => setActiveId(t.id)}
            onClose={() => closeTabById(t.id)}
            onStartRename={() => setRenaming({ id: t.id, title: t.title })}
            onRenameChange={(title) => setRenaming({ id: t.id, title })}
            onRenameDone={(save) => {
              if (save && renaming !== null) setTabs(renameTab(tabs, t.id, renaming.title));
              setRenaming(null);
            }}
          />
        ))}
        <button
          type="button"
          disabled={tabs.length >= MAX_TABS}
          title={tabs.length >= MAX_TABS ? `The editor holds up to ${MAX_TABS} tabs.` : undefined}
          onClick={() => openTab({ sql: "", database: tab.database, title: null })}
          className={`${buttonClass.quiet} px-2 py-1.5`}
        >
          New tab
        </button>
      </div>

      <div role="toolbar" aria-label="Run" className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={databaseId} className="text-sm font-medium">
            Database
          </label>
          <select
            id={databaseId}
            value={tab.database ?? ""}
            onChange={(e) => setTabs(updateTab(tabs, tab.id, { database: e.target.value || null }))}
            className={`${inputClass} w-auto! max-w-56 py-1.5`}
          >
            <option value="">{dialect === "mysql" ? "None selected" : "Default database"}</option>
            {tab.database !== null && !known.has(tab.database) && (
              <option value={tab.database}>{tab.database}</option>
            )}
            {userDatabases.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
            {systemDatabases.length > 0 && (
              <optgroup label="System databases">
                {systemDatabases.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={limitId} className="text-sm font-medium">
            Row limit
          </label>
          <select
            id={limitId}
            value={maxRows}
            onChange={(e) => setMaxRows(Number(e.target.value))}
            className={`${inputClass} w-auto! py-1.5`}
          >
            {ROW_LIMITS.map((limit) => (
              <option key={limit} value={limit}>
                {limit.toLocaleString("en-US")}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            onClick={() => run("selection")}
            className={`${buttonClass.primary} py-1.5`}
          >
            Run
          </button>
          <button
            type="button"
            disabled={busy}
            aria-keyshortcuts="Control+Shift+Enter Meta+Shift+Enter"
            onClick={() => run("all")}
            className={`${buttonClass.secondary} py-1.5`}
          >
            Run all
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={explain}
            className={`${buttonClass.secondary} py-1.5`}
          >
            Explain
          </button>
          {busy && (
            <button
              type="button"
              aria-keyshortcuts="Escape"
              onClick={() => void cancel()}
              className={`${buttonClass.danger} py-1.5`}
            >
              {phase.phase === "running" && phase.cancelling ? "Cancelling…" : "Cancel"}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
            className={`${buttonClass.secondary} py-1.5`}
          >
            Run a file
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".sql,.txt,text/plain,application/sql"
            hidden
            aria-label="SQL file to run"
            onChange={(e) => void onFileChosen(e)}
          />
        </div>
      </div>
      <p className="-mt-2 text-sm text-slate">{SHORTCUT_HINT}</p>
      {databases.isError && (
        <ErrorLine error={databases.error} onRetry={() => void databases.refetch()} />
      )}
      {notice !== null && (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={`border-l-2 pl-4 ${notice.tone === "error" ? "border-down" : "border-flag"}`}
        >
          {notice.text}
        </p>
      )}
      {storageFailed && (
        <p role="status" className="border-l-2 border-flag pl-4">
          This browser wouldn't store your tabs, so they won't be here next time.
        </p>
      )}

      <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="h-64 min-h-32 resize-y overflow-hidden border border-rule">
            <SqlEditor
              key={tab.id}
              ref={editor}
              value={tab.sql}
              dialect={dialect}
              schema={completion.data?.tables ?? NO_SCHEMA}
              errorRange={highlight}
              onChange={(sql) => setTabs((all) => updateTab(all, tab.id, { sql }))}
              onRunSelection={() => run("selection")}
              onRunAll={() => run("all")}
              onCancel={onCancelKey}
            />
          </div>
          <Results
            key={tab.id}
            phase={phase}
            dialect={dialect}
            shortcutHint={SHORTCUT_HINT}
            highlightable={highlightable}
            onHighlight={setHighlight}
          />
        </div>
        {wide ? (
          <aside className="w-80 shrink-0">{side}</aside>
        ) : (
          <details className="border-y border-rule py-3">
            <summary className="cursor-pointer font-medium">History and saved queries</summary>
            <div className="pt-4">{side}</div>
          </details>
        )}
      </div>

      <ConfirmDialog
        open={phase.phase === "confirm"}
        title="Run these statements?"
        confirmLabel="Run anyway"
        onCancel={() => setPhase(tab.id, declineConfirmation)}
        onConfirm={confirmRun}
      >
        <p className="text-slate">
          Dpilot ran nothing yet. These statements can change or remove data for good.
        </p>
        <ul className="mt-3 flex max-h-72 flex-col gap-3 overflow-auto">
          {phase.phase === "confirm" &&
            phase.statements.map((statement) => (
              <li key={statement.index} className="border-l-2 border-down pl-3">
                <code className="block font-mono text-xs break-all">
                  {statement.sql.length > 200 ? `${statement.sql.slice(0, 200)}…` : statement.sql}
                </code>
                <p className="mt-1 text-sm">
                  Statement {statement.index + 1}: {statement.reasons.join("; ")}
                </p>
              </li>
            ))}
        </ul>
      </ConfirmDialog>
    </div>
  );
}

function TabButton(props: {
  tab: Tab;
  active: boolean;
  running: boolean;
  renaming: string | null;
  onSelect: () => void;
  onClose: () => void;
  onStartRename: () => void;
  onRenameChange: (title: string) => void;
  onRenameDone: (save: boolean) => void;
}) {
  const { tab, active, renaming } = props;
  const frame = `flex items-center border border-b-0 ${
    active ? "border-rule bg-white" : "border-transparent hover:bg-white/50"
  }`;
  if (renaming !== null) {
    return (
      <div className={frame}>
        <input
          aria-label={`Rename ${tab.title}`}
          value={renaming}
          maxLength={40}
          // biome-ignore lint/a11y/noAutofocus: the field appears because the user asked to rename
          autoFocus
          onChange={(e) => props.onRenameChange(e.target.value)}
          onBlur={() => props.onRenameDone(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") props.onRenameDone(true);
            if (e.key === "Escape") {
              e.stopPropagation();
              props.onRenameDone(false);
            }
          }}
          className="w-32 px-2 py-1.5 text-sm"
        />
      </div>
    );
  }
  return (
    <div className={frame}>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        title="Double-click or press F2 to rename"
        onClick={props.onSelect}
        onDoubleClick={props.onStartRename}
        onKeyDown={(e) => {
          if (e.key === "F2") {
            e.preventDefault();
            props.onStartRename();
          }
        }}
        className={`max-w-48 truncate px-3 py-1.5 text-sm ${active ? "font-medium" : "text-slate"}`}
      >
        {props.running && (
          <span
            aria-hidden
            className="mr-2 inline-block size-2 animate-pulse rounded-full bg-flag"
          />
        )}
        {tab.title}
        {props.running && <span className="sr-only"> (running)</span>}
      </button>
      <button
        type="button"
        aria-label={`Close ${tab.title}`}
        onClick={props.onClose}
        className="px-2 py-1.5 text-sm text-slate hover:text-down"
      >
        ×
      </button>
    </div>
  );
}
