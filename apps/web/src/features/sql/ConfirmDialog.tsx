import { type ReactNode, useEffect, useId, useRef } from "react";
import { buttonClass } from "../../ui/button.ts";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  children: ReactNode;
  onConfirm: () => void;
  /** Called however the dialog closes without confirming: Cancel or Esc. */
  onCancel: () => void;
}

/** Native modal confirmation. Cancel comes first so it takes focus when the dialog opens. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const { open, title, confirmLabel, busy = false, error = null, children } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={() => {
        if (open) props.onCancel();
      }}
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-md bg-chart p-6 text-ink shadow-xl backdrop:bg-ink/40"
    >
      <h2 id={titleId} className="text-xl font-semibold">
        {title}
      </h2>
      <div className="mt-3">{children}</div>
      {error !== null && (
        <p role="alert" className="mt-4 text-down">
          {error}
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
          disabled={busy}
          onClick={props.onConfirm}
          className={buttonClass.danger}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
