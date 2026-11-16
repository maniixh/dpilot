import type { RowKey, TableRef } from "@dpilot/shared";
import { useRef, useState } from "react";
import { ApiError } from "../../api/client.ts";
import { cellUrl, useUploadCell } from "../../api/data.ts";
import { buttonClass } from "../../ui/button.ts";
import { describeEditError, MAX_CELL_BYTES } from "./edit-model.ts";

/** Download and replace for a binary cell; bytes never pass through the text editor. */
export function BlobCell(props: {
  target: string;
  db: string;
  tableRef: TableRef;
  column: string;
  /** Null when the table has no usable key, which the cell routes need to find the row. */
  rowKey: RowKey | null;
  isNull: boolean;
  /** False for views, keyless tables and read-only connections. */
  editable: boolean;
  reason: string | null;
}) {
  const { target, db, tableRef, column, rowKey, isNull, editable, reason } = props;
  const upload = useUploadCell(target, db);
  const file = useRef<HTMLInputElement>(null);
  const [oversize, setOversize] = useState<string | null>(null);
  const canWrite = editable && rowKey !== null;
  const canRead = rowKey !== null;

  // The server answers 413 without reading the body, which browsers can report as a dropped
  // connection, so a file that is certain to be refused is not sent at all.
  function choose(selected: File | undefined) {
    if (selected === undefined || rowKey === null) return;
    upload.reset();
    if (selected.size > MAX_CELL_BYTES) {
      setOversize(describeEditError({ status: 413, code: null, message: "" }));
      return;
    }
    setOversize(null);
    upload.mutate({ ref: tableRef, key: rowKey, column, bytes: selected });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-3">
        {canRead && !isNull ? (
          <a
            href={cellUrl(target, db, tableRef, rowKey, column)}
            download
            className={`${buttonClass.secondary} py-1.5`}
          >
            Download
          </a>
        ) : (
          <button
            type="button"
            disabled
            title={isNull ? "This cell is NULL." : (reason ?? "This row has no key.")}
            className={`${buttonClass.secondary} py-1.5`}
          >
            Download
          </button>
        )}
        <button
          type="button"
          disabled={!canWrite || upload.isPending}
          title={canWrite ? undefined : (reason ?? "This row has no key.")}
          onClick={() => file.current?.click()}
          className={`${buttonClass.secondary} py-1.5`}
        >
          {upload.isPending ? "Uploading…" : "Replace…"}
        </button>
        <input
          ref={file}
          type="file"
          hidden
          aria-label={`New file for ${column}`}
          onChange={(e) => {
            choose(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      {!canRead && reason !== null && <p className="text-sm text-slate">{reason}</p>}
      <p role={upload.isError || oversize !== null ? "alert" : "status"} className="text-sm">
        {oversize !== null && <span className="text-down">{oversize}</span>}
        {upload.isError &&
          (upload.error instanceof ApiError ? (
            <span className="text-down">{describeEditError(upload.error)}</span>
          ) : (
            <span className="text-down">Dpilot couldn't upload the file.</span>
          ))}
        {upload.isSuccess && "Replaced."}
      </p>
    </div>
  );
}
