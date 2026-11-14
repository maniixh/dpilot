import {
  type CreateInstanceRequest,
  createInstanceRequestSchema,
  ENGINES,
  type EngineId,
  getEngine,
} from "@dpilot/shared";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Link, useLocation } from "wouter";
import { ApiError } from "../../api/client.ts";
import { useCreateInstance, useEngineVersions } from "../../api/instances.ts";
import { buttonClass } from "../../ui/button.ts";

type Field = keyof CreateInstanceRequest;

const FIELD_HINTS: Record<Field, string> = {
  engine: "Choose an engine.",
  version: "Choose a version.",
  name: "Use 2 to 31 lowercase letters, digits or hyphens, starting with a letter.",
  port: "Use a whole number from 1024 to 65535.",
  password: "Use 8 to 128 characters without spaces.",
  database: "Use lowercase letters, digits and underscores, starting with a letter or underscore.",
};

export function NewInstanceScreen() {
  const [, navigate] = useLocation();
  const create = useCreateInstance();
  const [engine, setEngine] = useState<EngineId>("mysql");
  const [version, setVersion] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [port, setPort] = useState("");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");
  const [invalid, setInvalid] = useState<ReadonlySet<Field>>(new Set());
  const versions = useEngineVersions(engine);

  const info = getEngine(engine);
  const chosenVersion = version ?? versions.data?.versions[0] ?? "";
  const chosenName = name ?? engine;

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = createInstanceRequestSchema.safeParse({
      engine,
      version: chosenVersion,
      name: chosenName,
      port: port.trim() === "" ? undefined : Number(port),
      password: password === "" ? undefined : password,
      database: database.trim() === "" ? undefined : database.trim(),
    });
    if (!parsed.success) {
      setInvalid(new Set(parsed.error.issues.map((issue) => issue.path[0] as Field)));
      return;
    }
    setInvalid(new Set());
    create.mutate(parsed.data, {
      onSuccess: (summary) => navigate(`/instances/${summary.name}`),
    });
  }

  return (
    <form onSubmit={submit} noValidate className="flex max-w-2xl flex-col gap-10">
      <div>
        <Link href="/" className={buttonClass.quiet}>
          Back to servers
        </Link>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight">New database server</h1>
      </div>

      <fieldset>
        <legend className="mb-3 text-lg font-semibold">Engine</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {ENGINES.map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer flex-col gap-1 rounded-md border border-rule bg-white/40 p-4 has-checked:border-ink has-checked:bg-white has-focus-visible:outline-3 has-focus-visible:outline-flag"
            >
              <input
                type="radio"
                name="engine"
                value={option.id}
                checked={engine === option.id}
                onChange={() => {
                  setEngine(option.id);
                  setVersion(null);
                }}
                className="sr-only"
              />
              <span className="text-lg font-semibold">{option.label}</span>
              <span className="text-sm text-slate">Port {option.defaultPort} by default</span>
            </label>
          ))}
        </div>
      </fieldset>

      <Field
        label="Version"
        invalid={invalid.has("version")}
        hint={versionHint(versions.data?.source)}
        error={FIELD_HINTS.version}
      >
        {(id, describedBy) => (
          <select
            id={id}
            aria-describedby={describedBy}
            value={chosenVersion}
            onChange={(e) => setVersion(e.target.value)}
            disabled={!versions.data}
            className={inputClass}
          >
            {!versions.data && <option value="">Loading versions…</option>}
            {versions.data?.versions.map((v) => (
              <option key={v} value={v}>
                {info.label} {v}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field
        label="Server name"
        invalid={invalid.has("name")}
        hint="Names the server, not a database inside it. The Docker container is named dpilot-<name>."
        error={FIELD_HINTS.name}
      >
        {(id, describedBy) => (
          <input
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid.has("name")}
            value={chosenName}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className={`${inputClass} font-mono`}
          />
        )}
      </Field>

      <Field
        label="First database"
        invalid={invalid.has("database")}
        hint="Optional. Dpilot creates this empty database inside the server and connects to it by default."
        error={FIELD_HINTS.database}
      >
        {(id, describedBy) => (
          <input
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid.has("database")}
            placeholder="None"
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className={`${inputClass} font-mono`}
          />
        )}
      </Field>

      <div className="grid gap-10 sm:grid-cols-2">
        <Field
          label="Port"
          invalid={invalid.has("port")}
          hint={`Leave empty to use the first free port from ${info.defaultPort}.`}
          error={FIELD_HINTS.port}
        >
          {(id, describedBy) => (
            <input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid.has("port")}
              inputMode="numeric"
              placeholder="Automatic"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className={`${inputClass} font-mono`}
            />
          )}
        </Field>

        <Field
          label={`Password for ${info.defaultUser}`}
          invalid={invalid.has("password")}
          hint="Leave empty and Dpilot generates one."
          error={FIELD_HINTS.password}
        >
          {(id, describedBy) => (
            <input
              id={id}
              type="password"
              aria-describedby={describedBy}
              aria-invalid={invalid.has("password")}
              autoComplete="new-password"
              placeholder="Generated"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${inputClass} font-mono`}
            />
          )}
        </Field>
      </div>

      {create.isError && (
        <p role="alert" className="border-l-2 border-down pl-4">
          {create.error instanceof ApiError ? create.error.message : "Dpilot couldn't create it."}
        </p>
      )}

      <div>
        <button
          type="submit"
          disabled={create.isPending || !versions.data}
          className={buttonClass.primary}
        >
          {create.isPending ? "Creating…" : "Create server"}
        </button>
      </div>
    </form>
  );
}

const inputClass =
  "w-full rounded-md border border-rule bg-white px-3 py-2 text-ink aria-invalid:border-down disabled:opacity-60";

function versionHint(source: "docker-hub" | "fallback" | undefined): string {
  if (source === "fallback") {
    return "Docker Hub couldn't be reached, so this is Dpilot's built-in list.";
  }
  return "Newest first, from Docker Hub. The image downloads when you create the server.";
}

function Field({
  label,
  hint,
  error,
  invalid,
  children,
}: {
  label: string;
  hint: string;
  error?: string;
  invalid: boolean;
  children: (id: string, describedBy: string) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-lg font-semibold">
        {label}
      </label>
      {children(id, hintId)}
      <p id={hintId} className={`text-sm ${invalid ? "text-down" : "text-slate"}`}>
        {invalid && error ? error : hint}
      </p>
    </div>
  );
}
