import { getEngine } from "@dpilot/shared";
import { databaseHref, targetHref } from "../explorer/paths.ts";
import { OverviewHeader, useTarget } from "../explorer/ServerOverview.tsx";

/** The editor itself arrives with the SQL editor task; this screen carries the route and header. */
export function EditorScreen({ target, db }: { target: string; db: string | null }) {
  const state = useTarget(target);
  const summary = state.status === "found" ? state.summary : undefined;
  const label = summary?.label ?? target;

  return (
    <OverviewHeader
      title="SQL editor"
      subline={summary === undefined ? label : `${getEngine(summary.engine).label} on ${label}`}
      back={
        db === null
          ? { href: targetHref(target), label: `Back to ${label}` }
          : { href: databaseHref(target, db), label: `Back to ${db}` }
      }
    />
  );
}
