import { type Filter, getEngine, type RowsQuery, type Sort } from "@dpilot/shared";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useRowCount, useRows, useTableMeta } from "../../api/data.ts";
import { buttonClass } from "../../ui/button.ts";
import { inputClass } from "../../ui/form.tsx";
import { databaseHref } from "../explorer/paths.ts";
import { ErrorLine, useTarget } from "../explorer/ServerOverview.tsx";
import { AggregateBar } from "./AggregateBar.tsx";
import { ValuePanel } from "./CellView.tsx";
import { type ActiveCell, DataGrid } from "./DataGrid.tsx";
import { FilterBar } from "./FilterBar.tsx";
import { pageLabel, toggleSort } from "./grid-model.ts";

interface TableScreenProps {
  target: string;
  db: string;
  schema: string | null;
  table: string;
}

const PAGE_SIZES = [50, 100, 200, 500] as const;
const SEARCH_DELAY_MS = 300;

function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export function TableScreen({ target, db, schema, table }: TableScreenProps) {
  const state = useTarget(target);
  const summary = state.status === "found" ? state.summary : undefined;
  const ref = useMemo(() => ({ schema, table }), [schema, table]);
  const meta = useTableMeta(target, db, ref);

  const [sort, setSort] = useState<Sort[]>([]);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [limit, setLimit] = useState<number>(100);
  const [offset, setOffset] = useState(0);
  const [active, setActive] = useState<ActiveCell | null>(null);
  const searchId = useId();
  const sizeId = useId();
  const gridArea = useRef<HTMLDivElement>(null);

  const settled = useDebounced(searchText.trim(), SEARCH_DELAY_MS);
  const search = settled === "" ? null : settled;
  const ready = meta.data !== undefined;

  // Any change to what is being asked for starts again from the first page.
  useEffect(() => {
    setOffset(0);
    setActive(null);
  }, [sort, filters, search, limit]);

  const panelOpen = active !== null;
  // Esc closes the value panel from the grid or from inside the panel itself.
  useEffect(() => {
    if (!panelOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key !== "Escape" ||
        !(event.target instanceof Node && gridArea.current?.contains(event.target))
      )
        return;
      event.preventDefault();
      closePanel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [panelOpen]);

  function closePanel() {
    setActive(null);
    gridArea.current?.querySelector<HTMLElement>('[role="grid"]')?.focus();
  }
  const query: RowsQuery = { ref, filters, search, sort, offset, limit };
  const rows = useRows(target, db, query, ready);
  const count = useRowCount(target, db, { ref, filters, search }, ready);
  const total = count.data?.count ?? null;

  const columns = meta.data?.columns ?? [];
  const pageRows = rows.data?.rows ?? [];
  const lastPage = total === null ? pageRows.length < limit : offset + pageRows.length >= total;
  const kind = meta.data?.kind === "view" ? "View" : "Table";
  const where = schema === null ? db : `${db} · ${schema}`;
  const server =
    summary === undefined ? "" : ` · ${getEngine(summary.engine).label} on ${summary.label}`;
  const activeColumn = active === null ? undefined : columns[active.col];
  const activeValue = active === null ? undefined : pageRows[active.row]?.[active.col];
  const narrowed = filters.length > 0 || search !== null;

  function clearNarrowing() {
    setFilters([]);
    setSearchText("");
  }

  return (
    <div className="flex flex-col gap-5">
      <header>
        <Link href={databaseHref(target, db)} className={buttonClass.quiet}>
          Back to {db}
        </Link>
        <h1 className="mt-3 font-mono text-2xl font-semibold tracking-tight break-all">{table}</h1>
        <p className="mt-1 text-slate">{`${kind} in ${where}${server}`}</p>
      </header>

      {meta.data?.readOnlyReason !== null && meta.data?.readOnlyReason !== undefined && (
        <p role="status" className="border-l-2 border-flag pl-4">
          <span className="font-medium">Read-only.</span> {meta.data.readOnlyReason}
        </p>
      )}

      {meta.data === undefined ? (
        meta.isPending ? (
          <p className="text-slate">Loading…</p>
        ) : (
          <ErrorLine error={meta.error} onRetry={() => void meta.refetch()} />
        )
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3 lg:flex-nowrap">
            <div className="flex min-w-48 flex-1 flex-col gap-1 sm:max-w-sm">
              <label htmlFor={searchId} className="text-sm font-medium">
                Search
              </label>
              <input
                id={searchId}
                type="search"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                maxLength={200}
                spellCheck={false}
                placeholder="Search text columns"
                className={`${inputClass} py-1.5`}
              />
            </div>
            <button
              type="button"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((v) => !v)}
              className={`${buttonClass.secondary} py-1.5`}
            >
              {filters.length > 0 ? `Filter (${filters.length})` : "Filter"}
            </button>
            <div className="flex flex-col gap-1">
              <label htmlFor={sizeId} className="text-sm font-medium">
                Rows per page
              </label>
              <select
                id={sizeId}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                className={`${inputClass} w-auto! py-1.5`}
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </div>
            <nav aria-label="Pages" className="flex shrink-0 items-center gap-3 sm:ml-auto">
              <p aria-live="polite" className="font-mono text-sm">
                {pageLabel(offset, total, pageRows.length)}
              </p>
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
                className={`${buttonClass.secondary} py-1.5`}
              >
                Previous
              </button>
              <button
                type="button"
                disabled={lastPage}
                onClick={() => setOffset(offset + limit)}
                className={`${buttonClass.secondary} py-1.5`}
              >
                Next
              </button>
            </nav>
          </div>

          <div hidden={!filtersOpen}>
            <FilterBar columns={columns} onApply={setFilters} />
          </div>

          {rows.data === undefined ? (
            rows.isPending ? (
              <p className="text-slate">Loading rows…</p>
            ) : (
              <ErrorLine error={rows.error} onRetry={() => void rows.refetch()} />
            )
          ) : (
            <>
              {rows.isError && <ErrorLine error={rows.error} onRetry={() => void rows.refetch()} />}
              {pageRows.length === 0 ? (
                <EmptyRows narrowed={narrowed} offset={offset} onClear={clearNarrowing} />
              ) : (
                <div ref={gridArea} className="flex flex-col gap-4 lg:flex-row lg:items-start">
                  <div className="min-w-0 flex-1">
                    <DataGrid
                      columns={columns}
                      primaryKey={meta.data.primaryKey}
                      rows={pageRows}
                      firstRow={offset + 1}
                      sort={sort}
                      onSort={(column, additive) => setSort(toggleSort(sort, column, additive))}
                      active={active}
                      onActiveChange={setActive}
                      label={`Rows of ${table}`}
                      busy={rows.isFetching}
                    />
                  </div>
                  {activeColumn !== undefined && activeValue !== undefined && (
                    <aside
                      className={
                        "border border-rule bg-white/50 p-4 lg:sticky lg:top-8 lg:w-96 lg:shrink-0"
                      }
                    >
                      <ValuePanel column={activeColumn} value={activeValue} onClose={closePanel} />
                    </aside>
                  )}
                </div>
              )}
              <AggregateBar
                target={target}
                db={db}
                refTable={ref}
                columns={columns}
                filters={filters}
                search={search}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

function EmptyRows(props: { narrowed: boolean; offset: number; onClear: () => void }) {
  if (props.narrowed) {
    return (
      <p className="border border-dashed border-rule p-6">
        No rows match.{" "}
        <button type="button" onClick={props.onClear} className="underline underline-offset-2">
          Clear filters and search
        </button>
      </p>
    );
  }
  return (
    <p className="border border-dashed border-rule p-6 text-slate">
      {props.offset > 0 ? "No rows on this page." : "This table has no rows."}
    </p>
  );
}
