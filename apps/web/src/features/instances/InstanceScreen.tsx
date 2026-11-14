import { getEngine, type InstanceDetail, type InstanceStatus } from "@dpilot/shared";
import { type ReactNode, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { ApiError } from "../../api/client.ts";
import {
  type InstanceAction,
  useInstance,
  useInstanceAction,
  useInstanceCompose,
  useInstanceLogs,
  useInstanceStats,
  useRemoveInstance,
} from "../../api/instances.ts";
import { buttonClass } from "../../ui/button.ts";
import { CopyButton } from "../../ui/CopyButton.tsx";
import { Fact, Facts } from "../../ui/Facts.tsx";
import { StateMark } from "../../ui/StateMark.tsx";
import { availableActions, formatBytes, pullPercent } from "./present.ts";

const PROVISIONING = new Set<InstanceStatus>(["pulling", "creating", "failed"]);
const RUNNING = new Set<InstanceStatus>(["starting", "ready", "unhealthy", "restarting"]);

const ACTION_LABELS: Record<InstanceAction, { label: string; pending: string }> = {
  start: { label: "Start", pending: "Starting…" },
  stop: { label: "Stop", pending: "Stopping…" },
  restart: { label: "Restart", pending: "Restarting…" },
};

export function InstanceScreen({ name }: { name: string }) {
  const instance = useInstance(name);

  if (instance.isPending) return <p className="text-slate">Loading {name}…</p>;
  const missing = instance.error instanceof ApiError && instance.error.status === 404;
  if (instance.data && !missing) {
    return (
      <>
        {instance.isError && (
          <p role="status" className="mb-8 border-l-2 border-flag pl-4 text-slate">
            Dpilot couldn't refresh this page, so it may be out of date. Retrying…
          </p>
        )}
        <InstanceView instance={instance.data} />
      </>
    );
  }
  return (
    <section className="max-w-prose">
      <h1 className="text-3xl font-semibold tracking-tight">
        {missing ? `There's no server named ${name}.` : `Dpilot couldn't load ${name}.`}
      </h1>
      {!missing && instance.error instanceof ApiError && (
        <p className="mt-4 text-lg text-slate">{instance.error.message}</p>
      )}
      <Link href="/" className={`${buttonClass.secondary} mt-6`}>
        Back to servers
      </Link>
    </section>
  );
}

function InstanceView({ instance }: { instance: InstanceDetail }) {
  const { state } = instance;
  const provisioned = !PROVISIONING.has(state.status);

  return (
    <div className="flex flex-col gap-12">
      <header>
        <Link href="/" className={buttonClass.quiet}>
          Back to servers
        </Link>
        <h1 className="mt-4 font-mono text-4xl font-semibold tracking-tight break-all">
          {instance.name}
        </h1>
        <p className="mt-2 text-lg text-slate">
          {getEngine(instance.engine).label} {instance.version} on 127.0.0.1:{instance.port}
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-4" aria-live="polite">
          <StateMark state={state} size="lg" />
          <Actions instance={instance} />
        </div>
      </header>

      {state.status === "pulling" && <PullBar progress={state.progress} />}
      {state.status === "failed" && (
        <p role="alert" className="max-w-prose border-l-2 border-down pl-4">
          {state.error}
        </p>
      )}

      {instance.connection && <ConnectionFacts connection={instance.connection} />}
      {RUNNING.has(state.status) && <StatsFacts name={instance.name} />}
      {provisioned && <Logs name={instance.name} />}
      {provisioned && <Compose name={instance.name} />}
    </div>
  );
}

function Actions({ instance }: { instance: InstanceDetail }) {
  const action = useInstanceAction(instance.name);
  const status = instance.state.status;
  const busy = action.isPending;
  const available = availableActions(status);
  const canRemove = status !== "pulling" && status !== "creating";

  return (
    <div className="flex flex-wrap items-center gap-3">
      {available.map((a) => (
        <button
          key={a}
          type="button"
          disabled={busy}
          onClick={() => action.mutate(a)}
          className={buttonClass.secondary}
        >
          {busy && action.variables === a ? ACTION_LABELS[a].pending : ACTION_LABELS[a].label}
        </button>
      ))}
      {canRemove && <RemoveButton instance={instance} />}
      {action.isError && (
        <p role="alert" className="basis-full text-down">
          {action.error instanceof ApiError ? action.error.message : "That didn't work."}
        </p>
      )}
    </div>
  );
}

function RemoveButton({ instance }: { instance: InstanceDetail }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [deleteData, setDeleteData] = useState(false);
  const [, navigate] = useLocation();
  const remove = useRemoveInstance(instance.name);
  const failed = instance.state.status === "failed";

  if (failed) {
    return (
      <button
        type="button"
        disabled={remove.isPending}
        onClick={() => remove.mutate(false, { onSuccess: () => navigate("/") })}
        className={buttonClass.secondary}
      >
        Dismiss
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDeleteData(false);
          dialog.current?.showModal();
        }}
        className={buttonClass.secondary}
      >
        Remove
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="remove-title"
        className="m-auto max-w-md rounded-md bg-chart p-6 text-ink shadow-xl backdrop:bg-ink/40"
      >
        <h2 id="remove-title" className="text-xl font-semibold">
          Remove {instance.name}?
        </h2>
        <p className="mt-3 text-slate">
          The container is deleted. Its data stays in the Docker volume{" "}
          <span className="font-mono text-sm text-ink">{instance.volume}</span> unless you delete it
          too.
        </p>
        <label className="mt-5 flex items-start gap-3">
          <input
            type="checkbox"
            checked={deleteData}
            onChange={(e) => setDeleteData(e.target.checked)}
            className="mt-1 size-4 accent-down"
          />
          <span>Also delete the data. This can't be undone.</span>
        </label>
        {remove.isError && (
          <p role="alert" className="mt-4 text-down">
            {remove.error instanceof ApiError ? remove.error.message : "Removing failed."}
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
              remove.mutate(deleteData, {
                onSuccess: () => {
                  dialog.current?.close();
                  navigate("/");
                },
              })
            }
            className={buttonClass.danger}
          >
            {deleteData ? "Remove and delete data" : "Remove server"}
          </button>
        </div>
      </dialog>
    </>
  );
}

function PullBar({
  progress,
}: {
  progress: Extract<InstanceDetail["state"], { status: "pulling" }>["progress"];
}) {
  const percent = pullPercent(progress);
  return (
    <section className="max-w-xl">
      <div className="h-2 overflow-hidden rounded-full bg-rule">
        <div
          role="progressbar"
          aria-label="Image download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          className="h-full bg-flag transition-[width]"
          style={{ width: `${percent ?? 5}%` }}
        />
      </div>
      <p className="mt-2 text-sm text-slate">
        {progress.totalBytes > 0
          ? `${formatBytes(progress.currentBytes)} of ${formatBytes(progress.totalBytes)}, `
          : ""}
        {progress.layersDone} of {progress.layersTotal} layers done. This happens once per version.
      </p>
    </section>
  );
}

function ConnectionFacts({
  connection,
}: {
  connection: NonNullable<InstanceDetail["connection"]>;
}) {
  const [reveal, setReveal] = useState(false);
  const masked = "•".repeat(12);
  const shownUrl = reveal
    ? connection.url
    : connection.url.replace(`:${encodeURIComponent(connection.password)}@`, `:${masked}@`);

  return (
    <Facts title="Connect">
      <Fact term="Host" mono action={<CopyButton value={connection.host} label="host" />}>
        {connection.host}
      </Fact>
      <Fact term="Port" mono action={<CopyButton value={String(connection.port)} label="port" />}>
        {connection.port}
      </Fact>
      <Fact term="User" mono action={<CopyButton value={connection.user} label="user" />}>
        {connection.user}
      </Fact>
      {connection.database && (
        <Fact
          term="Database"
          mono
          action={<CopyButton value={connection.database} label="database" />}
        >
          {connection.database}
        </Fact>
      )}
      <Fact
        term="Password"
        mono
        action={
          <>
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              className={buttonClass.quiet}
            >
              {reveal ? "Hide" : "Show"}
            </button>
            <CopyButton value={connection.password} label="password" />
          </>
        }
      >
        {reveal ? connection.password : masked}
      </Fact>
      <Fact term="URL" mono action={<CopyButton value={connection.url} label="connection URL" />}>
        {shownUrl}
      </Fact>
    </Facts>
  );
}

function StatsFacts({ name }: { name: string }) {
  const stats = useInstanceStats(name, true);
  const data = stats.data;
  return (
    <Facts title="Resources">
      <Fact term="CPU">{data ? `${data.cpuPercent.toFixed(1)}%` : "…"}</Fact>
      <Fact term="Memory">
        {data ? `${formatBytes(data.memoryBytes)} of ${formatBytes(data.memoryLimitBytes)}` : "…"}
      </Fact>
    </Facts>
  );
}

function Logs({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const logs = useInstanceLogs(name, open);
  return (
    <Disclosure title="Logs" open={open} onToggle={setOpen}>
      <pre className="max-h-96 overflow-auto rounded-md bg-ink p-4 font-mono text-xs leading-relaxed text-chart">
        {logs.data
          ? logs.data.lines.join("\n") || "No log output yet."
          : logs.isError
            ? "Dpilot couldn't read the logs."
            : "Loading logs…"}
      </pre>
      <p className="mt-2 text-sm text-slate">The last 200 lines, refreshed every 5 seconds.</p>
    </Disclosure>
  );
}

function Compose({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const compose = useInstanceCompose(name, open);
  const data = compose.data;
  return (
    <Disclosure title="Docker Compose file" open={open} onToggle={setOpen}>
      <p className="mb-3 max-w-prose text-slate">
        Run this server without Dpilot. It uses the same data volume, so stop it here first.
      </p>
      <pre className="max-h-96 overflow-auto rounded-md bg-white p-4 font-mono text-xs leading-relaxed">
        {data?.yaml ?? (compose.isError ? "Dpilot couldn't build the file." : "Loading…")}
      </pre>
      {data && (
        <div className="mt-3 flex gap-4">
          <button
            type="button"
            onClick={() => downloadText(data.fileName, data.yaml)}
            className={buttonClass.secondary}
          >
            Download {data.fileName}
          </button>
          <CopyButton value={data.yaml} label="Compose file" />
        </div>
      )}
    </Disclosure>
  );
}

function downloadText(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/yaml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function Disclosure({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary className="cursor-pointer border-b border-rule pb-2 text-lg font-semibold">
        {title}
      </summary>
      <div className="mt-4">{children}</div>
    </details>
  );
}
