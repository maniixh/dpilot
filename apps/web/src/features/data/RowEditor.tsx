import type { ColumnMeta, EditValue, TableMeta, TableRef } from "@dpilot/shared";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../../api/client.ts";
import { useInsertRow } from "../../api/data.ts";
import { buttonClass } from "../../ui/button.ts";
import { inputClass } from "../../ui/form.tsx";
import {
  buildInsert,
  type CellDraft,
  describeEditError,
  insertDraft,
  isEditableColumn,
  parseDraft,
  toCellDraft,
} from "./edit-model.ts";

const TINY_BUTTON =
  "rounded border border-ink/30 px-1.5 text-[11px] leading-5 text-ink hover:border-ink " +
  "hover:bg-white/60";

const hasDefault = (column: ColumnMeta): boolean =>
  column.autoIncrement || column.defaultValue !== null;

/** Edits one cell in place: Enter keeps the text, Esc drops it, and the cell regains focus. */
export function CellEditor(props: {
  column: ColumnMeta;
  initial: CellDraft;
  onCommit: (value: EditValue) => void;
  onCancel: () => void;
}) {
  const { column, initial, onCommit, onCancel } = props;
  const [text, setText] = useState(initial.mode === "value" ? initial.text : "");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();

  useEffect(() => input.current?.select(), []);

  function commit(draft: CellDraft) {
    const parsed = parseDraft(draft, column);
    if (typeof parsed === "string") setError(parsed);
    else onCommit(parsed);
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      commit({ mode: "value", text });
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  }

  return (
    <fieldset
      aria-label={`Edit ${column.name}`}
      onKeyDown={onKeyDown}
      className="absolute top-0 left-0 z-30 m-0 flex min-w-72 flex-col gap-1 border-2 border-ink bg-white p-1 font-sans"
    >
      <div className="flex items-center gap-1">
        <input
          ref={input}
          type="text"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          aria-label={`Value of ${column.name}`}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
          spellCheck={false}
          className="min-w-0 flex-1 px-1 font-mono leading-6 outline-none"
        />
        {column.nullable && (
          <button type="button" onClick={() => commit({ mode: "null" })} className={TINY_BUTTON}>
            NULL
          </button>
        )}
        {hasDefault(column) && (
          <button type="button" onClick={() => commit({ mode: "default" })} className={TINY_BUTTON}>
            Default
          </button>
        )}
      </div>
      {error !== null && (
        <p id={errorId} role="alert" className="px-1 text-xs whitespace-normal text-down">
          {error}
        </p>
      )}
    </fieldset>
  );
}

type Drafts = Record<string, CellDraft>;

function startingDrafts(meta: TableMeta): Drafts {
  return Object.fromEntries(
    Object.entries(insertDraft(meta)).map(([name, value]) => [name, toCellDraft(value)]),
  );
}

/** The add-row form: one field per writable column, with NULL and default as explicit choices. */
export function InsertRowForm(props: {
  target: string;
  db: string;
  meta: TableMeta;
  tableRef: TableRef;
  onClose: () => void;
}) {
  const { target, db, meta, tableRef, onClose } = props;
  const insert = useInsertRow(target, db);
  const [drafts, setDrafts] = useState<Drafts>(() => startingDrafts(meta));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const form = useRef<HTMLFormElement>(null);
  const id = useId();
  const columns = meta.columns.filter(isEditableColumn);
  const hasBinary = meta.columns.some((column) => column.kind === "binary");

  useEffect(() => {
    form.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus();
  }, []);

  function change(name: string, draft: CellDraft) {
    setDrafts((current) => ({ ...current, [name]: draft }));
    setErrors(({ [name]: _gone, ...rest }) => rest);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const request = buildInsert(meta, tableRef, drafts);
    if ("errors" in request) {
      setErrors(request.errors);
      return;
    }
    insert.mutate(request, { onSuccess: onClose });
  }

  return (
    <form
      ref={form}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      aria-label="Add row"
      className="flex flex-col gap-4 border border-rule bg-white/50 p-4"
    >
      <h2 className="text-lg font-semibold">Add row</h2>
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
        {columns.map((column, index) => (
          <InsertField
            key={column.name}
            fieldId={`${id}-${index}`}
            column={column}
            draft={drafts[column.name] ?? { mode: "default" }}
            error={errors[column.name]}
            onChange={(draft) => change(column.name, draft)}
          />
        ))}
      </div>
      {hasBinary && (
        <p className="text-sm text-slate">
          Binary columns start empty. Replace them from the value panel once the row exists.
        </p>
      )}
      {insert.isError && (
        <p role="alert" className="border-l-2 border-down pl-4">
          {insert.error instanceof ApiError
            ? describeEditError(insert.error)
            : "Dpilot couldn't add the row."}
        </p>
      )}
      <div className="flex gap-3">
        <button type="submit" disabled={insert.isPending} className={buttonClass.primary}>
          {insert.isPending ? "Adding…" : "Add row"}
        </button>
        <button type="button" onClick={onClose} className={buttonClass.secondary}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function InsertField(props: {
  fieldId: string;
  column: ColumnMeta;
  draft: CellDraft;
  error: string | undefined;
  onChange: (draft: CellDraft) => void;
}) {
  const { fieldId, column, draft, error, onChange } = props;
  const errorId = `${fieldId}-error`;
  const text = draft.mode === "value" ? draft.text : "";
  const toggle = (mode: "null" | "default") => (checked: boolean) =>
    onChange(checked ? { mode } : { mode: "value", text: "" });

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={fieldId} className="flex items-baseline gap-2">
        <span className="font-mono font-semibold break-all">{column.name}</span>
        <span className="font-mono text-xs text-slate">{column.type}</span>
      </label>
      <input
        id={fieldId}
        type="text"
        value={text}
        disabled={draft.mode !== "value"}
        onChange={(e) => onChange({ mode: "value", text: e.target.value })}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
        placeholder={draft.mode === "default" ? "Default" : draft.mode === "null" ? "NULL" : ""}
        spellCheck={false}
        className={`${inputClass} py-1.5 font-mono`}
      />
      <div className="flex gap-4 text-sm">
        {column.nullable && (
          <ModeBox
            label={`NULL for ${column.name}`}
            text="NULL"
            checked={draft.mode === "null"}
            onChange={toggle("null")}
          />
        )}
        {hasDefault(column) && (
          <ModeBox
            label={`Default for ${column.name}`}
            text="Default"
            checked={draft.mode === "default"}
            onChange={toggle("default")}
          />
        )}
      </div>
      {error !== undefined && (
        <p id={errorId} role="alert" className="text-sm text-down">
          {error}
        </p>
      )}
    </div>
  );
}

function ModeBox(props: {
  label: string;
  text: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <input
        type="checkbox"
        aria-label={props.label}
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      {props.text}
    </label>
  );
}
