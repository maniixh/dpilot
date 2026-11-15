import { getEngine, type ObjectGroups } from "@dpilot/shared";
import { useObjects, useSchemas } from "../../api/explorer.ts";
import { targetHref } from "./paths.ts";
import { ErrorLine, OverviewHeader, useTargetSummary } from "./ServerOverview.tsx";

const GROUPS = [
  { key: "tables", label: "Tables", empty: "No tables." },
  { key: "views", label: "Views", empty: "No views." },
  { key: "procedures", label: "Procedures", empty: "No procedures." },
  { key: "functions", label: "Functions", empty: "No functions." },
] as const;

const GROUP_HEADING =
  "flex items-baseline justify-between border-b border-rule pb-2 text-lg font-semibold";

export function DatabaseOverview({ target, db }: { target: string; db: string }) {
  const summary = useTargetSummary(target);
  const label = summary?.label ?? target;
  const postgres = summary?.engine === "postgres";

  return (
    <div className="flex flex-col gap-12">
      <OverviewHeader
        title={db}
        subline={summary === undefined ? label : `${getEngine(summary.engine).label} on ${label}`}
        back={{ href: targetHref(target), label: `Back to ${label}` }}
      />
      {summary === undefined ? (
        <p className="text-slate">Loading…</p>
      ) : postgres ? (
        <Schemas target={target} db={db} />
      ) : (
        <Objects target={target} db={db} schema={null} />
      )}
    </div>
  );
}

function Schemas({ target, db }: { target: string; db: string }) {
  const schemas = useSchemas(target, db, true);
  if (schemas.data === undefined) {
    return schemas.isPending ? (
      <p className="text-slate">Loading schemas…</p>
    ) : (
      <ErrorLine error={schemas.error} onRetry={() => void schemas.refetch()} />
    );
  }
  if (schemas.data.length === 0) return <p className="text-slate">No schemas.</p>;
  return (
    <div className="flex flex-col gap-12">
      {schemas.data.map((schema) => (
        <section key={schema.name} aria-label={`Schema ${schema.name}`}>
          <h2 className="mb-4 font-mono text-2xl font-semibold tracking-tight break-all">
            {schema.name}
          </h2>
          <Objects target={target} db={db} schema={schema.name} />
        </section>
      ))}
    </div>
  );
}

function Objects({ target, db, schema }: { target: string; db: string; schema: string | null }) {
  const objects = useObjects(target, db, schema, true);
  if (objects.data === undefined) {
    return objects.isPending ? (
      <p className="text-slate">Loading…</p>
    ) : (
      <ErrorLine error={objects.error} onRetry={() => void objects.refetch()} />
    );
  }
  return <Groups groups={objects.data} />;
}

function Groups({ groups }: { groups: ObjectGroups }) {
  return (
    <div className="grid gap-10 sm:grid-cols-2">
      {GROUPS.map((group) => (
        <section key={group.key}>
          <h3 className={GROUP_HEADING}>
            {group.label}
            <span className="text-sm font-normal text-slate">{groups[group.key].length}</span>
          </h3>
          {groups[group.key].length === 0 ? (
            <p className="py-3 text-slate">{group.empty}</p>
          ) : (
            <ul className="divide-y divide-rule">
              {groups[group.key].map((name) => (
                <li key={name} className="py-2 font-mono text-sm break-all">
                  {name}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
