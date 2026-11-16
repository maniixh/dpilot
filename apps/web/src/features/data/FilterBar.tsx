import type { ColumnMeta, Filter } from "@dpilot/shared";
import { useId, useState } from "react";
import { buttonClass } from "../../ui/button.ts";
import { inputClass } from "../../ui/form.tsx";
import {
  type FilterDraft,
  filterOps,
  opLabel,
  opTakesValue,
  parseFilterDraft,
} from "./grid-model.ts";

interface DraftRow extends FilterDraft {
  id: number;
  error: string | null;
}

interface FilterBarProps {
  columns: readonly ColumnMeta[];
  onApply: (filters: Filter[]) => void;
}

const selectClass = `${inputClass} w-auto! min-w-0 py-1.5`;

export function FilterBar({ columns, onApply }: FilterBarProps) {
  const nextId = useState(() => ({ value: 1 }))[0];
  const groupId = useId();
  const [rows, setRows] = useState<DraftRow[]>(() => [blankRow(columns, 0)]);

  function blankRow(source: readonly ColumnMeta[], id: number): DraftRow {
    const first = source[0];
    return { id, column: first?.name ?? "", op: "eq", value: "", error: null };
  }

  function patch(id: number, change: Partial<DraftRow>) {
    setRows((all) => all.map((r) => (r.id === id ? { ...r, ...change, error: null } : r)));
  }

  function changeColumn(row: DraftRow, name: string) {
    const kind = columns.find((c) => c.name === name)?.kind ?? "text";
    const op = filterOps(kind).includes(row.op) ? row.op : "eq";
    patch(row.id, { column: name, op });
  }

  function apply() {
    const parsed = rows.map((row) => parseFilterDraft(row));
    setRows((all) =>
      all.map((row, i) => {
        const result = parsed[i];
        return { ...row, error: typeof result === "string" ? result : null };
      }),
    );
    const filters = parsed.filter((p): p is Filter => typeof p !== "string");
    if (filters.length === parsed.length) onApply(filters);
  }

  function clear() {
    setRows([blankRow(columns, nextId.value++)]);
    onApply([]);
  }

  return (
    <form
      aria-label="Filters"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
      className="flex flex-col gap-3 border border-rule bg-white/50 p-3"
    >
      {rows.map((row) => {
        const kind = columns.find((c) => c.name === row.column)?.kind ?? "text";
        const rowId = `${groupId}-${row.id}`;
        return (
          <div key={row.id} className="flex flex-wrap items-start gap-2">
            <select
              aria-label="Column"
              value={row.column}
              onChange={(e) => changeColumn(row, e.target.value)}
              className={`${selectClass} max-w-48 font-mono`}
            >
              {columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Operator"
              value={row.op}
              onChange={(e) => {
                const op = filterOps(kind).find((o) => o === e.target.value);
                if (op !== undefined) patch(row.id, { op });
              }}
              className={selectClass}
            >
              {filterOps(kind).map((op) => (
                <option key={op} value={op}>
                  {opLabel(op)}
                </option>
              ))}
            </select>
            {opTakesValue(row.op) && (
              <div className="flex min-w-40 flex-1 flex-col gap-1">
                <input
                  aria-label="Value"
                  aria-invalid={row.error !== null}
                  aria-describedby={row.error === null ? undefined : `${rowId}-error`}
                  value={row.value}
                  onChange={(e) => patch(row.id, { value: e.target.value })}
                  spellCheck={false}
                  placeholder={row.op === "in" || row.op === "not_in" ? "a, b, c" : undefined}
                  className={`${inputClass} py-1.5 font-mono`}
                />
                {row.error !== null && (
                  <p id={`${rowId}-error`} className="text-sm text-down">
                    {row.error}
                  </p>
                )}
              </div>
            )}
            {rows.length > 1 && (
              <button
                type="button"
                onClick={() => setRows((all) => all.filter((r) => r.id !== row.id))}
                className={`${buttonClass.quiet} py-2`}
              >
                Remove
              </button>
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={`${buttonClass.primary} py-1.5`}>
          Apply filters
        </button>
        <button
          type="button"
          disabled={rows.length >= 20}
          onClick={() => setRows((all) => [...all, blankRow(columns, nextId.value++)])}
          className={`${buttonClass.secondary} py-1.5`}
        >
          Add filter
        </button>
        <button type="button" onClick={clear} className={`${buttonClass.secondary} py-1.5`}>
          Clear
        </button>
      </div>
    </form>
  );
}
