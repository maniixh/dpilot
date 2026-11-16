import {
  type Dialect,
  type QueryRun,
  type StatementOutcome,
  splitStatements,
} from "@dpilot/shared";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  errorRange,
  formatDuration,
  gapLabel,
  outcomeTitle,
  type ResultItem,
  type RunPhase,
  type RunSource,
  runSummary,
  windowOutcomes,
} from "./editor-model.ts";
import { ResultGrid } from "./ResultGrid.tsx";
import type { EditorRange } from "./SqlEditor.tsx";

interface ResultsProps {
  phase: RunPhase;
  dialect: Dialect;
  shortcutHint: string;
  /** What the tab's editor currently holds: error highlights only apply while it matches. */
  highlightable: (source: RunSource) => boolean;
  onHighlight: (range: EditorRange | null) => void;
}

export function Results({
  phase,
  dialect,
  shortcutHint,
  highlightable,
  onHighlight,
}: ResultsProps) {
  switch (phase.phase) {
    case "running":
      return <Running cancelling={phase.cancelling} />;
    case "failed":
      return (
        <p role="alert" className="border-l-2 border-down pl-4">
          {phase.message}
        </p>
      );
    case "done":
      return (
        <RunResults
          run={phase.run}
          source={phase.source}
          dialect={dialect}
          highlightable={highlightable}
          onHighlight={onHighlight}
        />
      );
    case "confirm":
    case "idle":
      return (
        <p className="border border-dashed border-rule p-6 text-slate">
          Run a statement to see its results here. {shortcutHint}
        </p>
      );
  }
}

function Running({ cancelling }: { cancelling: boolean }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <p role="status" className="flex items-baseline gap-3">
      <span aria-hidden className="size-2.5 animate-pulse rounded-full bg-flag" />
      {cancelling ? "Cancellingâ€¦" : "Runningâ€¦"}
      <span className="font-mono text-sm text-slate">{formatDuration(seconds * 1000)}</span>
    </p>
  );
}

function defaultSelection(items: readonly ResultItem[]): number {
  const outcomes = items.flatMap((item) => (item.kind === "outcome" ? [item.outcome] : []));
  const failed = outcomes.find((o) => o.kind === "error");
  return (failed ?? outcomes.find((o) => o.kind === "rows") ?? outcomes[0])?.index ?? 0;
}

function RunResults(props: {
  run: QueryRun;
  source: RunSource;
  dialect: Dialect;
  highlightable: (source: RunSource) => boolean;
  onHighlight: (range: EditorRange | null) => void;
}) {
  const { run, source, dialect, highlightable, onHighlight } = props;
  const items = useMemo(() => windowOutcomes(run), [run]);
  const [selected, setSelected] = useState(() => defaultSelection(items));
  const tabs = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelected(defaultSelection(items));
  }, [items]);

  const outcome = items
    .flatMap((item) => (item.kind === "outcome" ? [item.outcome] : []))
    .find((o) => o.index === selected);

  const range = useMemo(() => {
    if (outcome === undefined || !highlightable(source)) return null;
    const statement = splitStatements(source.sql, dialect)[outcome.index];
    return statement === undefined ? null : errorRange(statement, outcome, source.offset);
  }, [outcome, source, dialect, highlightable]);

  useEffect(() => {
    onHighlight(range);
    return () => onHighlight(null);
  }, [range, onHighlight]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const indexes = items.flatMap((item) => (item.kind === "outcome" ? [item.outcome.index] : []));
    const at = indexes.indexOf(selected);
    const next = indexes[(at + step + indexes.length) % indexes.length];
    if (next === undefined) return;
    setSelected(next);
    tabs.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus();
  }

  return (
    <section aria-label="Results" className="flex flex-col gap-3">
      <p role="status" className="text-sm text-slate">
        {runSummary(run)}
      </p>
      {items.length === 0 ? (
        <p className="border border-dashed border-rule p-6 text-slate">
          Nothing ran. The script has no statements.
        </p>
      ) : (
        <>
          <div
            ref={tabs}
            role="tablist"
            aria-label="Statement results"
            onKeyDown={onKeyDown}
            className="flex items-center gap-1 overflow-x-auto border-b border-rule"
          >
            {items.map((item) =>
              item.kind === "gap" ? (
                <span
                  key={`gap-${item.from}`}
                  className="shrink-0 px-3 py-1.5 text-xs text-slate italic"
                >
                  {gapLabel(item)}
                </span>
              ) : (
                <ResultTab
                  key={item.outcome.index}
                  outcome={item.outcome}
                  selected={item.outcome.index === selected}
                  onSelect={() => setSelected(item.outcome.index)}
                />
              ),
            )}
          </div>
          {outcome !== undefined && <OutcomePanel outcome={outcome} />}
        </>
      )}
    </section>
  );
}

function ResultTab(props: { outcome: StatementOutcome; selected: boolean; onSelect: () => void }) {
  const { outcome, selected } = props;
  return (
    <button
      type="button"
      role="tab"
      data-index={outcome.index}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onClick={props.onSelect}
      className={`shrink-0 border-b-2 px-3 py-1.5 text-sm whitespace-nowrap ${
        selected ? "border-ink font-medium" : "border-transparent text-slate hover:text-ink"
      } ${outcome.kind === "error" ? "text-down!" : ""}`}
    >
      {outcomeTitle(outcome)}
    </button>
  );
}

function OutcomePanel({ outcome }: { outcome: StatementOutcome }) {
  return (
    <div role="tabpanel" className="flex flex-col gap-3">
      <p className="flex items-baseline gap-3">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-slate" title={outcome.sql}>
          {outcome.sql}
        </code>
        <span className="shrink-0 font-mono text-xs text-slate">
          {formatDuration(outcome.durationMs)}
        </span>
      </p>
      {outcome.kind === "error" && (
        <p role="alert" className="border-l-2 border-down pl-4 font-mono text-sm break-words">
          {outcome.message}
          {outcome.position !== null && (
            <span className="block text-xs text-slate">At character {outcome.position + 1}.</span>
          )}
        </p>
      )}
      {outcome.kind === "affected" && (
        <p>
          {outcome.affected.toLocaleString("en-US")} {outcome.affected === 1 ? "row" : "rows"}{" "}
          affected{outcome.command === null ? "" : ` Â· ${outcome.command}`}
        </p>
      )}
      {outcome.kind === "rows" &&
        (outcome.rows.length === 0 ? (
          <p className="border border-dashed border-rule p-6 text-slate">No rows returned.</p>
        ) : (
          <>
            <ResultGrid
              columns={outcome.columns}
              rows={outcome.rows}
              label={`Rows of statement ${outcome.index + 1}`}
            />
            {outcome.truncated && (
              <p role="status" className="border-l-2 border-flag pl-4 text-sm">
                Showing the first {outcome.rows.length.toLocaleString("en-US")} rows. The query
                returned more. Add a LIMIT or choose a higher row limit, up to 10,000.
              </p>
            )}
          </>
        ))}
    </div>
  );
}
