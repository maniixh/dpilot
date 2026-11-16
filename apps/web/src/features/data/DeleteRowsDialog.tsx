import type { RowKey, TableRef } from "@dpilot/shared";
import { useEffect, useRef } from "react";
import { ApiError } from "../../api/client.ts";
import { useDeleteRows } from "../../api/data.ts";
import { buttonClass } from "../../ui/button.ts";
import { describeEditError, describeKey } from "./edit-model.ts";

const SHOWN_KEYS = 5;

/** Native modal confirmation; closing it any way (Cancel, Esc, success) reports through onClose. */
export function DeleteRowsDialog(props: {
  open: boolean;
  target: string;
  db: string;
  tableRef: TableRef;
  keys: RowKey[];
  onClose: (deleted: boolean) => void;
}) {
  const { open, target, db, tableRef, keys, onClose } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const remove = useDeleteRows(target, db);
  const { reset } = remove;

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      reset();
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open, reset]);

  const count = keys.length;
  const noun = count === 1 ? "row" : "rows";

  return (
    <dialog
      ref={dialog}
      aria-labelledby="delete-rows-title"
      onClose={() => onClose(false)}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-md bg-chart p-6 text-ink shadow-xl backdrop:bg-ink/40"
    >
      <h2 id="delete-rows-title" className="text-xl font-semibold">
        Delete {count} {noun}?
      </h2>
      <p className="mt-3 text-slate">
        This removes {count === 1 ? "it" : "them"} from {tableRef.table} for good.
      </p>
      <ul className="mt-3 flex flex-col gap-1 font-mono text-xs break-all">
        {keys.slice(0, SHOWN_KEYS).map((key) => (
          <li key={describeKey(key)}>{describeKey(key)}</li>
        ))}
        {count > SHOWN_KEYS && <li className="text-slate">and {count - SHOWN_KEYS} more</li>}
      </ul>
      {remove.isError && (
        <p role="alert" className="mt-4 text-down">
          {remove.error instanceof ApiError
            ? describeEditError(remove.error)
            : "Dpilot couldn't delete the rows."}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={() => dialog.current?.close()}
          className={buttonClass.secondary}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={remove.isPending || count === 0}
          onClick={() => remove.mutate({ ref: tableRef, keys }, { onSuccess: () => onClose(true) })}
          className={buttonClass.danger}
        >
          {remove.isPending ? "Deleting…" : `Delete ${count} ${noun}`}
        </button>
      </div>
    </dialog>
  );
}
