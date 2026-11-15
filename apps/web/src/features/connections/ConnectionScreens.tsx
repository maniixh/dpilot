import type { SavedConnection } from "@dpilot/shared";
import { useRef } from "react";
import { Link, useLocation } from "wouter";
import { ApiError } from "../../api/client.ts";
import {
  useConnection,
  useCreateConnection,
  useDeleteConnection,
  useUpdateConnection,
} from "../../api/connections.ts";
import { buttonClass } from "../../ui/button.ts";
import { targetHref } from "../explorer/paths.ts";
import { ConnectionForm } from "./ConnectionForm.tsx";
import { emptyForm, fromSaved, toInput, toPatch } from "./form-model.ts";

const connectionHref = (id: string) => targetHref(`c.${id}`);

export function NewConnectionScreen() {
  const [, navigate] = useLocation();
  const create = useCreateConnection();
  return (
    <div className="flex flex-col gap-10">
      <div>
        <Link href="/" className={buttonClass.quiet}>
          Back to servers
        </Link>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight">Add connection</h1>
        <p className="mt-3 max-w-prose text-slate">
          Browse a database server Dpilot didn't create, on this computer or elsewhere.
        </p>
      </div>
      <ConnectionForm
        initial={emptyForm("mysql")}
        saved={null}
        saving={create.isPending}
        saveError={create.error}
        onSave={(values) =>
          create.mutate(toInput(values), {
            onSuccess: (connection) => navigate(connectionHref(connection.id)),
          })
        }
      />
    </div>
  );
}

export function EditConnectionScreen({ id }: { id: string }) {
  const connection = useConnection(id);

  if (connection.data === undefined) {
    return (
      <section aria-live="polite" className="max-w-prose">
        {connection.isPending ? (
          <p className="text-slate">Loading the connection…</p>
        ) : (
          <>
            <h1 className="text-3xl font-semibold tracking-tight">
              {connection.error instanceof ApiError && connection.error.status === 404
                ? "There's no saved connection here."
                : "Dpilot couldn't load this connection."}
            </h1>
            <Link href="/" className="mt-4 inline-block underline underline-offset-4">
              Go to your servers
            </Link>
          </>
        )}
      </section>
    );
  }
  return <EditConnection key={connection.data.updatedAt} saved={connection.data} />;
}

function EditConnection({ saved }: { saved: SavedConnection }) {
  const [, navigate] = useLocation();
  const update = useUpdateConnection(saved.id);
  return (
    <div className="flex flex-col gap-10">
      <div>
        <Link href={connectionHref(saved.id)} className={buttonClass.quiet}>
          Back to {saved.label}
        </Link>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight">Edit connection</h1>
      </div>
      <ConnectionForm
        initial={fromSaved(saved)}
        saved={saved}
        saving={update.isPending}
        saveError={update.error}
        onSave={(values) => {
          const patch = toPatch(values, saved);
          if (Object.keys(patch).length === 0) {
            navigate(connectionHref(saved.id));
            return;
          }
          update.mutate(patch, { onSuccess: () => navigate(connectionHref(saved.id)) });
        }}
      />
      <DeleteConnection saved={saved} />
    </div>
  );
}

function DeleteConnection({ saved }: { saved: SavedConnection }) {
  const [, navigate] = useLocation();
  const remove = useDeleteConnection(saved.id);
  const dialog = useRef<HTMLDialogElement>(null);

  return (
    <div className="max-w-2xl border-t border-rule pt-8">
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className={buttonClass.secondary}
      >
        Delete connection
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="delete-title"
        className="m-auto max-w-md rounded-md bg-chart p-6 text-ink shadow-xl backdrop:bg-ink/40"
      >
        <h2 id="delete-title" className="text-xl font-semibold">
          Delete {saved.label}?
        </h2>
        <p className="mt-3 text-slate">Dpilot forgets this connection. The server isn't changed.</p>
        {remove.isError && (
          <p role="alert" className="mt-4 text-down">
            {remove.error instanceof ApiError ? remove.error.message : "Dpilot couldn't delete it."}
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
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(undefined, {
                onSuccess: () => {
                  dialog.current?.close();
                  navigate("/");
                },
              })
            }
            className={buttonClass.danger}
          >
            {remove.isPending ? "Deleting…" : "Delete connection"}
          </button>
        </div>
      </dialog>
    </div>
  );
}
