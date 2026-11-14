import { getEngine, type SavedConnection, type TestResult, type TlsMode } from "@dpilot/shared";
import { type FormEvent, type ReactNode, useState } from "react";
import { ApiError } from "../../api/client.ts";
import { useTestConnection } from "../../api/connections.ts";
import { buttonClass } from "../../ui/button.ts";
import { Choices, EnginePicker, Field, inputClass } from "../../ui/form.tsx";
import {
  type FormField,
  type FormValues,
  invalidFields,
  needsPassword,
  switchEngine,
  toInput,
  toPatch,
} from "./form-model.ts";

const FIELD_ERRORS: Record<FormField, string> = {
  label: "Use 1 to 64 characters.",
  host: "Use a host name or IP address.",
  port: "Use a whole number from 1 to 65535.",
  username: "Enter a user name of up to 128 characters.",
  password: "Use up to 1024 characters.",
  database: "Use up to 128 characters.",
  ca: "Paste a PEM certificate, starting with -----BEGIN CERTIFICATE-----.",
};

/** Server error codes that point at a single field. */
const SERVER_FIELDS: Readonly<Record<string, FormField>> = {
  label_taken: "label",
  password_required: "password",
};

const TLS_OPTIONS: readonly { value: TlsMode; label: string; detail: string }[] = [
  { value: "off", label: "Off", detail: "No encryption. Fine for servers on this computer." },
  { value: "require", label: "Require", detail: "Encrypted, without checking the certificate." },
  { value: "verify", label: "Verify", detail: "Encrypted, and the certificate is checked." },
];

function errorText(error: Error, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function ConnectionForm({
  initial,
  saved,
  saving,
  saveError,
  onSave,
}: {
  initial: FormValues;
  /** The connection being edited, or null when adding one. */
  saved: SavedConnection | null;
  saving: boolean;
  saveError: Error | null;
  onSave: (values: FormValues) => void;
}) {
  const [values, setValues] = useState(initial);
  const [invalid, setInvalid] = useState<ReadonlySet<FormField>>(new Set());
  const test = useTestConnection();
  const passwordNeeded = saved !== null && needsPassword(values, saved);
  const engine = getEngine(values.engine);

  function update(changes: Partial<FormValues>) {
    setValues((current) => ({ ...current, ...changes }));
    test.reset();
  }

  function validate(): boolean {
    const fields = invalidFields(values, saved);
    setInvalid(fields);
    return fields.size === 0;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (validate()) onSave(values);
  }

  function runTest() {
    if (!validate()) return;
    test.mutate(saved === null ? toInput(values) : { ...toPatch(values, saved), id: saved.id });
  }

  const serverField =
    saveError instanceof ApiError && saveError.code !== null
      ? SERVER_FIELDS[saveError.code]
      : undefined;
  const isInvalid = (field: FormField) => invalid.has(field) || serverField === field;

  const text = (
    field: Exclude<FormField, "ca">,
    label: string,
    hint: ReactNode,
    props: { type?: string; placeholder?: string; mono?: boolean; autoComplete?: string } = {},
  ) => (
    <Field label={label} invalid={isInvalid(field)} hint={hint} error={FIELD_ERRORS[field]}>
      {(id, describedBy) => (
        <input
          id={id}
          type={props.type ?? "text"}
          aria-describedby={describedBy}
          aria-invalid={isInvalid(field)}
          placeholder={props.placeholder}
          autoComplete={props.autoComplete ?? "off"}
          spellCheck={false}
          value={values[field]}
          onChange={(e) => update({ [field]: e.target.value })}
          className={`${inputClass} ${props.mono === false ? "" : "font-mono"}`}
        />
      )}
    </Field>
  );

  const showPasswordNote = passwordNeeded || saved?.passwordLost === true;

  return (
    <form onSubmit={submit} noValidate className="flex max-w-2xl flex-col gap-10">
      {text("label", "Label", "How this connection appears in Dpilot.", { mono: false })}

      <EnginePicker
        value={values.engine}
        onChange={(engine) => {
          setValues((current) => switchEngine(current, engine));
          test.reset();
        }}
      />

      <div className="grid gap-10 sm:grid-cols-[1fr_10rem]">
        {text("host", "Host", "A host name or IP address.")}
        {text("port", "Port", `${engine.label} uses ${engine.defaultPort} by default.`)}
      </div>

      <div className="grid gap-10 sm:grid-cols-2">
        {text("username", "User", "The user Dpilot signs in as.")}
        {text(
          "password",
          "Password",
          showPasswordNote ? (
            <span className="text-down">Enter the password again.</span>
          ) : (
            "Stored encrypted on this computer."
          ),
          {
            type: "password",
            autoComplete: "new-password",
            placeholder: saved?.hasPassword === true ? "Saved. Leave empty to keep it." : "None",
          },
        )}
      </div>

      {text("database", "Default database", "Optional. Postgres uses postgres when empty.", {
        placeholder: "None",
      })}

      <Choices
        legend="TLS"
        name="tls"
        value={values.tlsMode}
        options={TLS_OPTIONS}
        onChange={(tlsMode) => update({ tlsMode })}
      />

      {values.tlsMode === "verify" && (
        <Field
          label="CA certificate"
          invalid={isInvalid("ca")}
          hint="The PEM certificate of the authority that signed the server's certificate."
          error={FIELD_ERRORS.ca}
        >
          {(id, describedBy) => (
            <textarea
              id={id}
              aria-describedby={describedBy}
              aria-invalid={isInvalid("ca")}
              rows={6}
              spellCheck={false}
              placeholder="-----BEGIN CERTIFICATE-----"
              value={values.ca}
              onChange={(e) => update({ ca: e.target.value })}
              className={`${inputClass} font-mono text-sm`}
            />
          )}
        </Field>
      )}

      <TestOutcome result={test.data} error={test.error} />

      {saveError !== null && (
        <p role="alert" className="border-l-2 border-down pl-4">
          {errorText(saveError, "Dpilot couldn't save it.")}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={saving || passwordNeeded} className={buttonClass.primary}>
          {saving ? "Saving…" : "Save connection"}
        </button>
        <button
          type="button"
          onClick={runTest}
          disabled={test.isPending}
          className={buttonClass.secondary}
        >
          {test.isPending ? "Testing…" : "Test connection"}
        </button>
      </div>
    </form>
  );
}

function TestOutcome({ result, error }: { result: TestResult | undefined; error: Error | null }) {
  let message: ReactNode = null;
  if (error !== null) {
    message = <span className="text-down">{errorText(error, "Dpilot couldn't test it.")}</span>;
  } else if (result?.ok === true) {
    message = `Connected to ${getEngine(result.info.engine).label} ${result.info.version}.`;
  } else if (result?.ok === false) {
    message = <span className="text-down">{result.message}</span>;
  }
  return (
    <p aria-live="polite" className={message === null ? "sr-only" : "border-l-2 border-rule pl-4"}>
      {message}
    </p>
  );
}
