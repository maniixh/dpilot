import type { CellValue, ColumnMeta } from "@dpilot/shared";
import type { ReactNode } from "react";
import { buttonClass } from "../../ui/button.ts";
import { CopyButton } from "../../ui/CopyButton.tsx";
import { formatCell } from "./grid-model.ts";

export function CellView({ value, column }: { value: CellValue; column: ColumnMeta }) {
  const { text, muted } = formatCell(value, column.kind);
  return <span className={muted ? "text-slate/70 italic" : undefined}>{text}</span>;
}

function copyText(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "object") return value.bytes.hex;
  return String(value);
}

/** The full value of the active cell, which the grid itself only shows clipped. */
export function ValuePanel(props: {
  column: ColumnMeta;
  value: CellValue;
  onClose: () => void;
  /** Controls for this kind of cell, such as a binary column's download and replace. */
  actions?: ReactNode;
}) {
  const { column, value, onClose, actions } = props;
  return (
    <section aria-label="Cell value" className="flex min-w-0 flex-col gap-3 text-sm">
      <header className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-mono text-base font-semibold break-all">{column.name}</h2>
          <p className="font-mono text-xs text-slate">{column.type}</p>
        </div>
        <div className="flex items-baseline gap-3">
          {value !== null && (
            <CopyButton value={copyText(value)} label={`value of ${column.name}`} />
          )}
          <button type="button" onClick={onClose} className={buttonClass.quiet}>
            Close
          </button>
        </div>
      </header>
      {value === null ? (
        <p className="text-slate italic">NULL</p>
      ) : typeof value === "object" ? (
        <div className="flex flex-col gap-2">
          <p>
            {value.bytes.size.toLocaleString("en-US")} bytes
            {value.bytes.truncated && " · showing the first 64"}
          </p>
          <pre className="max-h-80 overflow-auto font-mono text-xs break-all whitespace-pre-wrap">
            {value.bytes.hex}
          </pre>
        </div>
      ) : value === "" ? (
        <p className="text-slate italic">Empty string</p>
      ) : (
        <pre className="max-h-96 overflow-auto font-mono text-[13px] break-all whitespace-pre-wrap">
          {String(value)}
        </pre>
      )}
      {actions}
    </section>
  );
}
