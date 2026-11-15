import { getEngine, type TargetSummary } from "@dpilot/shared";
import { type ReactNode, useId, useState } from "react";
import { Link } from "wouter";
import { useServerInfo, useTargets, useVariables } from "../../api/explorer.ts";
import { buttonClass } from "../../ui/button.ts";
import { Fact, Facts } from "../../ui/Facts.tsx";
import { inputClass } from "../../ui/form.tsx";
import { filterVariables, formatUptime } from "./overview-model.ts";
import { errorText } from "./Sidebar.tsx";

/** The target's summary from the sidebar list, so headings show the label rather than the id. */
export function useTargetSummary(target: string): TargetSummary | undefined {
  const data = useTargets().data;
  if (data === undefined) return undefined;
  const servers = data.servers.status === "ok" ? data.servers.targets : [];
  return [...servers, ...data.connections].find((t) => t.id === target);
}

export function ErrorLine({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  return (
    <p role="alert" className="flex flex-wrap items-baseline gap-x-3 border-l-2 border-down pl-4">
      <span>{errorText(error) ?? "Dpilot couldn't load this."}</span>
      <button type="button" onClick={onRetry} className="underline underline-offset-2">
        Try again
      </button>
    </p>
  );
}

export function OverviewHeader({
  title,
  subline,
  back,
  children,
}: {
  title: string;
  subline: ReactNode;
  back?: { href: string; label: string };
  children?: ReactNode;
}) {
  return (
    <header>
      {back !== undefined && (
        <Link href={back.href} className={buttonClass.quiet}>
          {back.label}
        </Link>
      )}
      <h1 className="mt-4 font-mono text-4xl font-semibold tracking-tight break-all">{title}</h1>
      <p className="mt-2 text-lg text-slate">{subline}</p>
      {children}
    </header>
  );
}

export function ServerOverview({ target }: { target: string }) {
  const summary = useTargetSummary(target);
  const info = useServerInfo(target);
  const engine = info.data?.engine ?? summary?.engine;

  return (
    <div className="flex flex-col gap-12">
      <OverviewHeader
        title={summary?.label ?? target}
        subline={
          info.data !== undefined
            ? `${getEngine(info.data.engine).label} ${info.data.version}`
            : engine !== undefined
              ? getEngine(engine).label
              : "\u00a0"
        }
      >
        {summary?.kind === "connection" && (
          <Link
            href={`/connections/${encodeURIComponent(target.slice(2))}/edit`}
            className={`${buttonClass.secondary} mt-6`}
          >
            Edit connection
          </Link>
        )}
      </OverviewHeader>

      {info.data === undefined ? (
        info.isPending ? (
          <p className="text-slate">Connecting…</p>
        ) : (
          <ErrorLine error={info.error} onRetry={() => void info.refetch()} />
        )
      ) : (
        <>
          <Facts title="Server">
            <Fact term="User" mono>
              {info.data.user}
            </Fact>
            <Fact term="Uptime">{formatUptime(info.data.uptimeSeconds)}</Fact>
            <Fact term={info.data.engine === "postgres" ? "Encoding" : "Charset"} mono>
              {info.data.charset ?? "—"}
            </Fact>
            <Fact term="Time zone" mono>
              {info.data.timeZone ?? "—"}
            </Fact>
          </Facts>
          <Variables target={target} />
        </>
      )}
    </div>
  );
}

function Variables({ target }: { target: string }) {
  const variables = useVariables(target);
  const [query, setQuery] = useState("");
  const searchId = useId();
  const all = variables.data;
  const shown = all === undefined ? [] : filterVariables(all, query);
  const described = all?.some((v) => v.description !== null) === true;

  return (
    <section aria-labelledby={`${searchId}-title`} className="flex flex-col gap-4">
      <h2 id={`${searchId}-title`} className="border-b border-rule pb-2 text-lg font-semibold">
        Variables
      </h2>
      {all === undefined ? (
        variables.isPending ? (
          <p className="text-slate">Loading variables…</p>
        ) : (
          <ErrorLine error={variables.error} onRetry={() => void variables.refetch()} />
        )
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <label htmlFor={searchId} className="font-medium">
                Search variables
              </label>
              <input
                id={searchId}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
                className={`${inputClass} font-mono`}
              />
            </div>
            <p aria-live="polite" className="pb-2 text-sm text-slate">
              {shown.length} of {all.length}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full table-fixed border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-rule text-slate">
                  <th
                    scope="col"
                    className={`py-2 pr-6 font-medium ${described ? "w-3/10" : "w-1/2"}`}
                  >
                    Name
                  </th>
                  <th
                    scope="col"
                    className={`py-2 pr-6 font-medium ${described ? "w-1/4" : "w-1/2"}`}
                  >
                    Value
                  </th>
                  {described && (
                    <th scope="col" className="py-2 font-medium">
                      Description
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {shown.map((v) => (
                  <tr key={v.name} className="align-top">
                    <td className="py-2 pr-6 font-mono [overflow-wrap:anywhere]">{v.name}</td>
                    <td className="py-2 pr-6 font-mono [overflow-wrap:anywhere]">{v.value}</td>
                    {described && <td className="py-2 text-slate">{v.description ?? ""}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
