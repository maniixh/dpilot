import { getEngine, type InstanceSummary } from "@dpilot/shared";
import { Link } from "wouter";
import { ApiError } from "../../api/client.ts";
import { useInstances } from "../../api/instances.ts";
import { buttonClass } from "../../ui/button.ts";
import { StateMark } from "../../ui/StateMark.tsx";

export function InstanceList() {
  const instances = useInstances();

  return (
    <section aria-labelledby="databases-heading" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 id="databases-heading" className="text-4xl font-semibold tracking-tight">
          Database servers
        </h1>
        {instances.data && instances.data.length > 0 && (
          <Link href="/new" className={buttonClass.primary}>
            New server
          </Link>
        )}
      </div>

      {instances.isPending ? (
        <p className="text-slate">Loading servers…</p>
      ) : instances.isError ? (
        <p role="alert" className="border-l-2 border-down pl-4">
          {instances.error instanceof ApiError
            ? instances.error.message
            : "Dpilot couldn't load your servers."}
        </p>
      ) : instances.data.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="divide-y divide-rule border-y border-rule">
          {instances.data.map((instance) => (
            <li key={instance.name}>
              <InstanceRow instance={instance} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function InstanceRow({ instance }: { instance: InstanceSummary }) {
  return (
    <Link
      href={`/instances/${instance.name}`}
      className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 px-2 py-4 hover:bg-white/50 sm:grid-cols-[minmax(8rem,1.2fr)_1fr_1fr_minmax(10rem,1fr)] sm:items-baseline"
    >
      <span className="text-lg font-semibold">{instance.name}</span>
      <span className="text-slate sm:order-none">
        {getEngine(instance.engine).label} {instance.version}
      </span>
      <span className="font-mono text-sm text-slate">127.0.0.1:{instance.port}</span>
      <span className="col-span-2 sm:col-span-1">
        <StateMark state={instance.state} />
      </span>
    </Link>
  );
}

function EmptyState() {
  return (
    <div className="max-w-prose py-6">
      <p className="text-2xl font-semibold tracking-tight">No database servers yet.</p>
      <p className="mt-3 text-lg text-slate">
        Pick an engine and a version, and Dpilot runs it in Docker on this machine. Only programs on
        this computer can connect to it.
      </p>
      <Link href="/new" className={`${buttonClass.primary} mt-6`}>
        New server
      </Link>
    </div>
  );
}
