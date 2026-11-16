import { getEngine } from "@dpilot/shared";
import { useTableMeta } from "../../api/data.ts";
import { databaseHref } from "../explorer/paths.ts";
import { ErrorLine, OverviewHeader, useTarget } from "../explorer/ServerOverview.tsx";

interface TableScreenProps {
  target: string;
  db: string;
  schema: string | null;
  table: string;
}

/** The grid itself arrives with the data-grid tasks; this screen carries the route and header. */
export function TableScreen({ target, db, schema, table }: TableScreenProps) {
  const state = useTarget(target);
  const summary = state.status === "found" ? state.summary : undefined;
  const meta = useTableMeta(target, db, { schema, table });
  const where = schema === null ? db : `${db} · ${schema}`;
  const kind = meta.data?.kind === "view" ? "View" : "Table";
  const server =
    summary === undefined ? "" : ` · ${getEngine(summary.engine).label} on ${summary.label}`;

  return (
    <div className="flex flex-col gap-12">
      <OverviewHeader
        title={table}
        subline={`${kind} in ${where}${server}`}
        back={{ href: databaseHref(target, db), label: `Back to ${db}` }}
      />
      {meta.data === undefined ? (
        meta.isPending ? (
          <p className="text-slate">Loading…</p>
        ) : (
          <ErrorLine error={meta.error} onRetry={() => void meta.refetch()} />
        )
      ) : (
        <p className="text-slate">
          {meta.data.columns.length} columns
          {meta.data.primaryKey.length > 0 ? ` · key ${meta.data.primaryKey.join(", ")}` : ""}
        </p>
      )}
    </div>
  );
}
