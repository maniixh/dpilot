// biome-ignore-all lint/a11y: a virtualised table positions rows absolutely, so native table
// elements cannot be used; the scroller is focusable so the keyboard can scroll it.
import type { CellValue, ColumnKind } from "@dpilot/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { formatCell, isNumericKind } from "../data/grid-model.ts";

interface ResultGridProps {
  columns: readonly { name: string; kind: ColumnKind }[];
  rows: readonly CellValue[][];
  label: string;
}

const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 32;
const GUTTER_WIDTH = 56;
const WIDE_KINDS: readonly ColumnKind[] = ["json", "text", "datetime"];

function columnWidth(name: string, kind: ColumnKind): number {
  const base = WIDE_KINDS.includes(kind) ? 240 : isNumericKind(kind) ? 140 : 180;
  return Math.max(base, Math.min(name.length * 9 + 32, 320));
}

function cellText(value: CellValue): string {
  if (value === null) return "NULL";
  return typeof value === "object" ? value.bytes.hex : String(value);
}

/** A read-only, virtualised table of one result set. Cells reuse the data grid's formatting. */
export function ResultGrid({ columns, rows, label }: ResultGridProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const widths = columns.map((c) => columnWidth(c.name, c.kind));
  const width = GUTTER_WIDTH + widths.reduce((sum, w) => sum + w, 0);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <div
      ref={scroller}
      role="table"
      tabIndex={0}
      aria-label={label}
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length}
      className="relative max-h-[50dvh] min-h-20 overflow-auto border border-rule bg-white text-[13px]"
    >
      <div role="rowgroup" className="sticky top-0 z-20" style={{ width }}>
        <div role="row" className="flex bg-chart" style={{ height: HEADER_HEIGHT }}>
          <div
            className="sticky left-0 z-10 shrink-0 border-r border-b border-rule bg-chart"
            style={{ width: GUTTER_WIDTH }}
          />
          {columns.map((column, col) => (
            <div
              key={col}
              role="columnheader"
              className="shrink-0 truncate border-r border-b border-rule px-3 font-mono leading-8 font-semibold"
              style={{ width: widths[col] }}
              title={column.name}
            >
              {column.name}
            </div>
          ))}
        </div>
      </div>
      <div
        role="rowgroup"
        className="relative"
        style={{ height: virtualizer.getTotalSize(), width }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (row === undefined) return null;
          return (
            <div
              key={item.index}
              role="row"
              aria-rowindex={item.index + 2}
              className="group absolute left-0 flex"
              style={{ top: item.start, height: ROW_HEIGHT, width }}
            >
              <div
                role="rowheader"
                className="sticky left-0 z-10 shrink-0 border-r border-b border-rule bg-chart px-2 text-right font-mono text-[11px] leading-7 text-slate"
                style={{ width: GUTTER_WIDTH }}
              >
                {item.index + 1}
              </div>
              {columns.map((column, col) => {
                const value = row[col] ?? null;
                const { text, muted } = formatCell(value, column.kind);
                return (
                  <div
                    key={col}
                    role="cell"
                    title={cellText(value)}
                    className={`shrink-0 truncate border-r border-b border-rule/70 px-3 font-mono leading-7 whitespace-nowrap group-hover:bg-chart/60 ${
                      isNumericKind(column.kind) ? "text-right" : ""
                    }`}
                    style={{ width: widths[col] }}
                  >
                    <span className={muted ? "text-slate/70 italic" : undefined}>{text}</span>
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
