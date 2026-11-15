import { type DatabaseEntry, type EngineId, getEngine, type TargetSummary } from "@dpilot/shared";
import type { ReactNode } from "react";
import { Link } from "wouter";
import { ApiError } from "../../api/client.ts";
import { useDatabases, useObjects, useSchemas, useTargets } from "../../api/explorer.ts";
import { databaseHref, targetHref } from "./paths.ts";
import { Tree, TreeEmpty, TreeNode, TreeStatus } from "./TreeNode.tsx";
import { nodeId } from "./tree-model.ts";

export function errorText(error: Error | null): string | null {
  if (error === null) return null;
  return error instanceof ApiError ? error.message : "Dpilot couldn't load this.";
}

interface LevelQuery {
  isPending: boolean;
  error: Error | null;
  refetch: () => unknown;
}

/** Shows a level's loading or error line, or its content once loaded. */
function Level<T>({
  query,
  data,
  children,
}: {
  query: LevelQuery;
  data: T | undefined;
  children: (data: T) => ReactNode;
}) {
  if (data === undefined) {
    return (
      <TreeStatus
        loading={query.isPending}
        error={errorText(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }
  return children(data);
}

export function Sidebar() {
  const targets = useTargets();
  const data = targets.data;

  return (
    <nav aria-label="Browse" className="flex flex-col gap-6">
      <section aria-labelledby="sidebar-servers" className="flex flex-col gap-2">
        <h2
          id="sidebar-servers"
          className="text-xs font-semibold tracking-wide text-slate uppercase"
        >
          Dpilot servers
        </h2>
        {data === undefined ? (
          <SectionStatus query={targets} />
        ) : data.servers.status === "unavailable" ? (
          <p className="text-sm text-slate">{data.servers.message}</p>
        ) : data.servers.targets.length === 0 ? (
          <p className="text-sm text-slate">No servers yet.</p>
        ) : (
          <TargetTree label="Dpilot servers" targets={data.servers.targets} />
        )}
      </section>

      <section aria-labelledby="sidebar-connections" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2
            id="sidebar-connections"
            className="text-xs font-semibold tracking-wide text-slate uppercase"
          >
            Connections
          </h2>
          <Link
            href="/connections/new"
            className="text-sm font-medium underline-offset-4 hover:underline"
          >
            Add connection
          </Link>
        </div>
        {data === undefined ? (
          <SectionStatus query={targets} />
        ) : data.connections.length === 0 ? (
          <p className="text-sm text-slate">No saved connections.</p>
        ) : (
          <TargetTree label="Connections" targets={data.connections} />
        )}
      </section>
    </nav>
  );
}

function SectionStatus({ query }: { query: LevelQuery }) {
  const error = errorText(query.error);
  if (error === null) return <p className="text-sm text-slate">Loading…</p>;
  return (
    <p role="alert" className="text-sm">
      <span className="text-down">{error}</span>{" "}
      <button type="button" onClick={() => void query.refetch()} className="underline">
        Try again
      </button>
    </p>
  );
}

function TargetTree({ label, targets }: { label: string; targets: readonly TargetSummary[] }) {
  return (
    <Tree label={label}>
      {targets.map((target, index) => (
        <TargetNode key={target.id} target={target} first={index === 0} />
      ))}
    </Tree>
  );
}

function TargetNode({ target, first }: { target: TargetSummary; first: boolean }) {
  const id = nodeId([target.id]);
  return (
    <TreeNode
      id={id}
      first={first}
      label={target.label}
      href={targetHref(target.id)}
      expandable={target.available}
      hint={target.available ? getEngine(target.engine).label : target.reason}
    >
      <Databases target={target.id} engine={target.engine} />
    </TreeNode>
  );
}

function Databases({ target, engine }: { target: string; engine: EngineId }) {
  const query = useDatabases(target, true);
  return (
    <Level query={query} data={query.data}>
      {(databases) => {
        const user = databases.filter((db) => !db.system);
        const system = databases.filter((db) => db.system);
        return (
          <>
            {user.length === 0 && <TreeEmpty>No databases yet.</TreeEmpty>}
            {user.map((db) => (
              <DatabaseNode key={db.name} target={target} engine={engine} db={db} />
            ))}
            {system.length > 0 && (
              <TreeNode id={nodeId([target, "system"])} label="System databases" expandable>
                {system.map((db) => (
                  <DatabaseNode key={db.name} target={target} engine={engine} db={db} />
                ))}
              </TreeNode>
            )}
          </>
        );
      }}
    </Level>
  );
}

function DatabaseNode({
  target,
  engine,
  db,
}: {
  target: string;
  engine: EngineId;
  db: DatabaseEntry;
}) {
  return (
    <TreeNode
      id={nodeId([target, "db", db.name])}
      label={db.name}
      href={db.browsable ? databaseHref(target, db.name) : undefined}
      expandable={db.browsable}
      hint={db.browsable ? undefined : "Can't open"}
    >
      {engine === "postgres" ? (
        <Schemas target={target} db={db.name} />
      ) : (
        <Objects target={target} db={db.name} schema={null} />
      )}
    </TreeNode>
  );
}

function Schemas({ target, db }: { target: string; db: string }) {
  const query = useSchemas(target, db, true);
  return (
    <Level query={query} data={query.data}>
      {(schemas) =>
        schemas.length === 0 ? (
          <TreeEmpty>No schemas.</TreeEmpty>
        ) : (
          schemas.map((schema) => (
            <TreeNode
              key={schema.name}
              id={nodeId([target, "db", db, "schema", schema.name])}
              label={schema.name}
              expandable
            >
              <Objects target={target} db={db} schema={schema.name} />
            </TreeNode>
          ))
        )
      }
    </Level>
  );
}

const OBJECT_KINDS = [
  { key: "tables", label: "Tables" },
  { key: "views", label: "Views" },
  { key: "procedures", label: "Procedures" },
  { key: "functions", label: "Functions" },
] as const;

function Objects({ target, db, schema }: { target: string; db: string; schema: string | null }) {
  const query = useObjects(target, db, schema, true);
  const base = [target, "db", db, ...(schema === null ? [] : ["schema", schema])];
  return (
    <Level query={query} data={query.data}>
      {(groups) => {
        const kinds = OBJECT_KINDS.filter((kind) => groups[kind.key].length > 0);
        if (kinds.length === 0) return <TreeEmpty>Empty.</TreeEmpty>;
        return kinds.map((kind) => (
          <TreeNode
            key={kind.key}
            id={nodeId([...base, kind.key])}
            label={kind.label}
            hint={groups[kind.key].length}
            expandable
          >
            {groups[kind.key].map((name) => (
              <TreeNode
                key={name}
                id={nodeId([...base, kind.key, name])}
                label={name}
                expandable={false}
              />
            ))}
          </TreeNode>
        ));
      }}
    </Level>
  );
}
