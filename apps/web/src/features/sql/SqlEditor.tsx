import { MySQL, PostgreSQL, sql } from "@codemirror/lang-sql";
import { Compartment, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import type { Dialect } from "@dpilot/shared";
import { basicSetup } from "codemirror";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";

export interface SqlEditorHandle {
  doc(): string;
  selection(): { from: number; to: number };
  focus(): void;
}

export interface EditorRange {
  from: number;
  to: number;
}

interface SqlEditorProps {
  ref?: Ref<SqlEditorHandle>;
  value: string;
  dialect: Dialect;
  /** Table name to column names, for completion. */
  schema: Record<string, string[]>;
  errorRange: EditorRange | null;
  onChange: (value: string) => void;
  onRunSelection: () => void;
  onRunAll: () => void;
  /** Returns whether it handled the key, so Esc keeps its default when nothing is running. */
  onCancel: () => boolean;
}

const setError = StateEffect.define<EditorRange | null>();
const errorMark = Decoration.mark({ class: "cm-sql-error" });

const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setError)) continue;
      const range = effect.value;
      const length = transaction.state.doc.length;
      if (range === null || range.from >= length) return Decoration.none;
      return Decoration.set([errorMark.range(range.from, Math.min(range.to, length))]);
    }
    return transaction.docChanged ? Decoration.none : marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    backgroundColor: "white",
  },
  "&.cm-focused": { outline: "3px solid var(--color-flag)", outlineOffset: "-1px" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55", overflow: "auto" },
  ".cm-gutters": {
    backgroundColor: "var(--color-chart)",
    color: "var(--color-slate)",
    borderRight: "1px solid var(--color-rule)",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "rgb(242 183 5 / 0.12)" },
  ".cm-sql-error": {
    backgroundColor: "rgb(180 35 44 / 0.15)",
    textDecoration: "underline wavy var(--color-down)",
    textUnderlineOffset: "3px",
  },
});

function language(dialect: Dialect, schema: Record<string, string[]>) {
  return sql({
    dialect: dialect === "mysql" ? MySQL : PostgreSQL,
    schema,
    upperCaseKeywords: true,
  });
}

/** A CodeMirror 6 editor that the parent drives with props and queries through a handle. */
export function SqlEditor(props: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const languageSlot = useRef(new Compartment());
  const latest = useRef(props);
  latest.current = props;

  useImperativeHandle(props.ref, () => ({
    doc: () => view.current?.state.doc.toString() ?? "",
    selection: () => {
      const { from, to } = view.current?.state.selection.main ?? { from: 0, to: 0 };
      return { from, to };
    },
    focus: () => view.current?.focus(),
  }));

  useEffect(() => {
    if (host.current === null) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          Prec.highest(
            keymap.of([
              {
                key: "Mod-Enter",
                run: () => {
                  latest.current.onRunSelection();
                  return true;
                },
              },
              {
                key: "Mod-Shift-Enter",
                run: () => {
                  latest.current.onRunAll();
                  return true;
                },
              },
              { key: "Escape", run: () => latest.current.onCancel() },
            ]),
          ),
          basicSetup,
          languageSlot.current.of(language(latest.current.dialect, latest.current.schema)),
          errorField,
          theme,
          EditorView.contentAttributes.of({ "aria-label": "SQL editor", spellcheck: "false" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  const { dialect, schema, value, errorRange } = props;
  useEffect(() => {
    view.current?.dispatch({
      effects: languageSlot.current.reconfigure(language(dialect, schema)),
    });
  }, [dialect, schema]);

  useEffect(() => {
    const editor = view.current;
    if (editor === null || editor.state.doc.toString() === value) return;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const editor = view.current;
    if (editor === null) return;
    editor.dispatch({
      effects:
        errorRange === null
          ? setError.of(null)
          : [setError.of(errorRange), EditorView.scrollIntoView(errorRange.from, { y: "center" })],
    });
  }, [errorRange]);

  return <div ref={host} className="h-full min-h-0" />;
}
