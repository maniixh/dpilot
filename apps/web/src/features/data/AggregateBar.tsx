import type { AggregateFn, ColumnMeta, Filter, TableRef } from "@dpilot/shared";
import { useState } from "react";
import { useAggregate } from "../../api/data.ts";
import { ErrorLine } from "../explorer/ServerOverview.tsx";
import { aggregateFns, formatCell, isNumericKind } from "./grid-model.ts";

interface AggregateBarProps {
  target: string;
  db: string;
  refTable: TableRef;
  columns: readonly ColumnMeta[];
  filters: Filter[];
  search: string | null;
}

const FN_LABELS: Record<AggregateFn, string> = {
  count: "Count",
  sum: "Sum",
  avg: "Average",
  min: "Min",
  max: "Max",
};

/** Aggregates cover every row the filters and search match, not just the visible page. */
export function AggregateBar({
  target,
  db,
  refTable,
  columns,
  filters,
  search,
}: AggregateBarProps) {
  const [open, setOpen] = useState(false);
  const defaultColumn = (columns.find((c) => isNumericKind(c.kind)) ?? columns[0])?.name ?? "";
  const [name, setName] = useState(defaultColumn);
  const column = columns.find((c) => c.name === name) ?? columns[0];
  const fns = column === undefined ? [] : aggregateFns(column.kind);

  const result = useAggregate(
    target,
    db,
    {
      ref: refTable,
      filters,
      search,
      aggregates: fns.map((fn) => ({ fn, column: column?.name ?? null })),
    },
    open && column !== undefined,
  );

  return (
    <section
      aria-label="Aggregates"
      className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="font-medium underline underline-offset-4"
      >
        {open ? "Hide aggregates" : "Show aggregates"}
      </button>
      {open && column !== undefined && (
        <>
          <label className="flex items-center gap-2">
            <span className="text-slate">Column</span>
            <select
              value={column.name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-md border border-rule bg-white px-2 py-1 font-mono"
            >
              {columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {result.data === undefined ? (
            result.isPending ? (
              <p className="text-slate">Calculating…</p>
            ) : (
              <ErrorLine error={result.error} onRetry={() => void result.refetch()} />
            )
          ) : (
            <dl aria-live="polite" className="flex flex-wrap gap-x-6 gap-y-1">
              {fns.map((fn, i) => {
                const value = result.data.values[i];
                return (
                  <div key={fn} className="flex gap-2">
                    <dt className="text-slate">{FN_LABELS[fn]}</dt>
                    <dd className="font-mono">
                      {value === undefined ? "—" : formatCell(value, column.kind).text}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
        </>
      )}
    </section>
  );
}
