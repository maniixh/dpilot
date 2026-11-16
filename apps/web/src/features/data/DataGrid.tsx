// biome-ignore-all lint/a11y: a virtualised ARIA grid positions rows absolutely, so native table
// elements cannot be used; the container owns focus (aria-activedescendant) and the keyboard.
import type { CellValue, ColumnKind, ColumnMeta, EditValue, RowKey, Sort } from "@dpilot/shared";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef } from "react";
import { CellView } from "./CellView.tsx";
import {
  describeEdit,
  draftOf,
  isEditableColumn,
  type PendingEdits,
  rowId,
  toCellDraft,
} from "./edit-model.ts";
import { isNumericKind } from "./grid-model.ts";
import { CellEditor } from "./RowEditor.tsx";

export interface ActiveCell {
  row: number;
  col: number;
}

/** Present only when the table is editable, so its absence means the grid is read-only. */
export interface GridEditing {
  /** The server's key for each row of the page, in row order. */
  keys: readonly RowKey[];
  pending: PendingEdits;
  editCell: ActiveCell | null;
  selected: ReadonlySet<string>;
  onToggleRow: (id: string, on: boolean) => void;
  onToggleAll: (on: boolean) => void;
  onStartEdit: (cell: ActiveCell) => void;
  onCommit: (cell: ActiveCell, value: EditValue) => void;
  onCancel: () => void;
}

interface DataGridProps {
  columns: readonly ColumnMeta[];
  primaryKey: readonly string[];
  rows: CellValue[][];
  /** The 1-based number of the first row on this page, for the row gutter. */
  firstRow: number;
  sort: readonly Sort[];
  onSort: (column: string, additive: boolean) => void;
  active: ActiveCell | null;
  onActiveChange: (cell: ActiveCell) => void;
  editing?: GridEditing;
  label: string;
  busy: boolean;
}

const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 48;
const GUTTER_WIDTH = 56;
const EDIT_GUTTER_WIDTH = 84;
const PAGE_STEP = 10;

const KIND_WIDTHS: Record<ColumnKind, number> = {
  integer: 180,
  decimal: 150,
  float: 150,
  boolean: 100,
  date: 120,
  datetime: 240,
  time: 110,
  json: 260,
  binary: 200,
  text: 240,
  other: 200,
};

const GRID_CLASS =
  "relative max-h-[70dvh] min-h-24 overflow-auto border border-rule bg-white text-[13px] " +
  "transition-opacity";
const SORT_BUTTON_CLASS =
  "flex h-full w-full flex-col justify-center px-3 text-left hover:bg-white/60";
const ROW_NUMBER_CLASS =
  "sticky left-0 z-10 shrink-0 border-r border-b border-rule bg-chart px-2 text-right " +
  "font-mono text-[11px] leading-8 text-slate";
const CELL_CLASS =
  "shrink-0 truncate border-r border-b border-rule/70 px-3 font-mono leading-8 " +
  "whitespace-nowrap group-hover:bg-chart/60";
const ACTIVE_CLASS = "bg-flag/20 outline-2 -outline-offset-2 outline-ink";

const helper = createColumnHelper<CellValue[]>();

function useColumnDefs(columns: readonly ColumnMeta[]) {
  return useMemo(
    () =>
      columns.map((meta, index) =>
        helper.accessor((row) => row[index] ?? null, {
          id: meta.name,
          header: meta.name,
          size: KIND_WIDTHS[meta.kind],
          cell: (info) => <CellView value={info.getValue()} column={meta} />,
        }),
      ),
    [columns],
  );
}

function PendingCell({ value }: { value: EditValue }) {
  const { text, muted } = describeEdit(value);
  return (
    <span title="Not saved yet" className={muted ? "text-slate italic" : undefined}>
      {text}
    </span>
  );
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), Math.max(max, 0));
}

function sortLabel(sort: readonly Sort[], column: string): string {
  const index = sort.findIndex((s) => s.column === column);
  if (index === -1) return "";
  const arrow = sort[index]?.direction === "asc" ? "▲" : "▼";
  return sort.length > 1 ? `${arrow}${index + 1}` : arrow;
}

export function DataGrid(props: DataGridProps) {
  const { columns, primaryKey, rows, firstRow, sort, onSort, active, onActiveChange } = props;
  const { editing } = props;
  const gutter = editing === undefined ? GUTTER_WIDTH : EDIT_GUTTER_WIDTH;
  const gridId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const defs = useColumnDefs(columns);
  const sorting: SortingState = sort.map((s) => ({ id: s.column, desc: s.direction === "desc" }));

  const table = useReactTable({
    data: rows,
    columns: defs,
    state: { sorting },
    manualSorting: true,
    getCoreRowModel: getCoreRowModel(),
  });
  const tableRows = table.getRowModel().rows;
  const headers = table.getFlatHeaders();
  const width = gutter + headers.reduce((sum, h) => sum + h.getSize(), 0);
  const allSelected =
    editing !== undefined && editing.keys.length > 0 && editing.selected.size >= rows.length;
  const someSelected = editing !== undefined && editing.selected.size > 0 && !allSelected;

  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    scrollPaddingStart: HEADER_HEIGHT,
  });

  const cellId = (row: number, col: number) => `${gridId}-r${row}-c${col}`;
  const activeId = active === null ? undefined : cellId(active.row, active.col);

  useEffect(() => {
    if (activeId === undefined) return;
    document.getElementById(activeId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  function move(next: ActiveCell) {
    const target = {
      row: clamp(next.row, tableRows.length - 1),
      col: clamp(next.col, columns.length - 1),
    };
    virtualizer.scrollToIndex(target.row);
    onActiveChange(target);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || tableRows.length === 0) return;
    const at = active ?? { row: 0, col: 0 };
    if (editing !== undefined && active !== null) {
      const column = columns[at.col];
      if ((event.key === "Enter" || event.key === "F2") && column && isEditableColumn(column)) {
        event.preventDefault();
        editing.onStartEdit(at);
        return;
      }
      const key = editing.keys[at.row];
      if (event.key === " " && key !== undefined) {
        event.preventDefault();
        const id = rowId(key);
        editing.onToggleRow(id, !editing.selected.has(id));
        return;
      }
    }
    const jump = event.ctrlKey || event.metaKey;
    const moves: Record<string, ActiveCell> = {
      ArrowDown: { row: at.row + 1, col: at.col },
      ArrowUp: { row: at.row - 1, col: at.col },
      ArrowRight: { row: at.row, col: at.col + 1 },
      ArrowLeft: { row: at.row, col: at.col - 1 },
      PageDown: { row: at.row + PAGE_STEP, col: at.col },
      PageUp: { row: at.row - PAGE_STEP, col: at.col },
      Home: { row: jump ? 0 : at.row, col: 0 },
      End: { row: jump ? tableRows.length - 1 : at.row, col: columns.length - 1 },
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    move(active === null ? at : next);
  }

  return (
    <div
      ref={scroller}
      role="grid"
      tabIndex={0}
      aria-label={props.label}
      aria-busy={props.busy}
      aria-rowcount={tableRows.length + 1}
      aria-colcount={columns.length}
      aria-activedescendant={activeId}
      onKeyDown={onKeyDown}
      style={{ scrollPaddingLeft: gutter }}
      className={`${GRID_CLASS} ${props.busy ? "opacity-60" : ""}`}
    >
      <div role="rowgroup" className="sticky top-0 z-20" style={{ width }}>
        <div
          role="row"
          aria-rowindex={1}
          className="flex bg-chart"
          style={{ height: HEADER_HEIGHT }}
        >
          <div
            className="sticky left-0 z-10 flex shrink-0 items-end justify-center border-r border-b border-rule bg-chart pb-2"
            style={{ width: gutter }}
          >
            {editing !== undefined && (
              <input
                type="checkbox"
                aria-label="Select all rows on this page"
                checked={allSelected}
                ref={(el) => {
                  if (el !== null) el.indeterminate = someSelected;
                }}
                onChange={(e) => editing.onToggleAll(e.target.checked)}
              />
            )}
          </div>
          {headers.map((header, col) => {
            const meta = columns[col];
            const state = sortLabel(sort, header.column.id);
            const direction = sort.find((s) => s.column === header.column.id)?.direction;
            return (
              <div
                key={header.id}
                role="columnheader"
                aria-colindex={col + 1}
                aria-sort={
                  direction === undefined
                    ? "none"
                    : direction === "asc"
                      ? "ascending"
                      : "descending"
                }
                className="shrink-0 border-r border-b border-rule"
                style={{ width: header.getSize() }}
              >
                <button
                  type="button"
                  onClick={(event) => onSort(header.column.id, event.shiftKey)}
                  title="Click to sort. Shift-click adds a column."
                  className={SORT_BUTTON_CLASS}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono font-semibold">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </span>
                    {primaryKey.includes(header.column.id) && (
                      <span className="text-[10px] font-semibold tracking-wide text-slate">PK</span>
                    )}
                    <span aria-hidden className="text-[10px] text-ink">
                      {state}
                    </span>
                  </span>
                  <span className="truncate font-mono text-[11px] text-slate">{meta?.type}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div
        role="rowgroup"
        className="relative"
        style={{ height: virtualizer.getTotalSize(), width }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = tableRows[item.index];
          if (row === undefined) return null;
          const rowKey = editing?.keys[item.index];
          const id = rowKey === undefined ? null : rowId(rowKey);
          const pendingRow = id === null ? undefined : editing?.pending.get(id);
          const selected = id !== null && editing?.selected.has(id) === true;
          return (
            <div
              key={row.id}
              role="row"
              aria-rowindex={item.index + 2}
              aria-selected={editing === undefined ? undefined : selected}
              className={`group absolute left-0 flex ${selected ? "bg-flag/10" : ""}`}
              style={{ top: item.start, height: ROW_HEIGHT, width }}
            >
              <div
                role="rowheader"
                className={`${ROW_NUMBER_CLASS} ${editing === undefined ? "" : "flex items-center justify-between"}`}
                style={{ width: gutter }}
              >
                {editing !== undefined && id !== null && (
                  <input
                    type="checkbox"
                    aria-label={`Select row ${firstRow + item.index}`}
                    checked={selected}
                    onChange={(e) => editing.onToggleRow(id, e.target.checked)}
                  />
                )}
                <span>{firstRow + item.index}</span>
              </div>
              {row.getVisibleCells().map((cell, col) => {
                const isActive = active?.row === item.index && active.col === col;
                const meta = columns[col];
                const numeric = isNumericKind(meta?.kind ?? "text");
                const here = { row: item.index, col };
                const isEditing =
                  editing?.editCell?.row === item.index && editing.editCell.col === col;
                const pending = meta === undefined ? undefined : pendingRow?.values[meta.name];
                const canEdit =
                  editing !== undefined && meta !== undefined && isEditableColumn(meta);
                return (
                  <div
                    key={cell.id}
                    id={cellId(item.index, col)}
                    role="gridcell"
                    aria-colindex={col + 1}
                    aria-selected={isActive}
                    aria-readonly={editing === undefined || !canEdit}
                    onClick={() => {
                      if (isEditing) return;
                      onActiveChange(here);
                      scroller.current?.focus({ preventScroll: true });
                    }}
                    onDoubleClick={() => {
                      if (editing !== undefined && canEdit) editing.onStartEdit(here);
                    }}
                    className={[
                      CELL_CLASS,
                      numeric && "text-right",
                      pending !== undefined && "bg-flag/25 text-ink",
                      isEditing && "relative overflow-visible!",
                      isActive && ACTIVE_CLASS,
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{ width: cell.column.getSize() }}
                  >
                    {isEditing && editing !== undefined && meta !== undefined ? (
                      <CellEditor
                        column={meta}
                        initial={
                          pending === undefined
                            ? draftOf(row.original[col] ?? null)
                            : toCellDraft(pending)
                        }
                        onCommit={(value) => editing.onCommit(here, value)}
                        onCancel={editing.onCancel}
                      />
                    ) : pending !== undefined ? (
                      <PendingCell value={pending} />
                    ) : (
                      flexRender(cell.column.columnDef.cell, cell.getContext())
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
