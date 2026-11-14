import { ENGINES, type EngineId } from "@dpilot/shared";
import { type ReactNode, useId } from "react";

export const inputClass =
  "w-full rounded-md border border-rule bg-white px-3 py-2 text-ink aria-invalid:border-down disabled:opacity-60";

const choiceClass =
  "flex cursor-pointer flex-col gap-1 rounded-md border border-rule bg-white/40 p-4 has-checked:border-ink has-checked:bg-white has-focus-visible:outline-3 has-focus-visible:outline-flag";

/** A labelled input with a hint line that turns into the error when invalid. */
export function Field({
  label,
  hint,
  error,
  invalid,
  children,
}: {
  label: string;
  hint: ReactNode;
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

/** Radio cards; each option has a title and a line of detail. */
export function Choices<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: readonly { value: T; label: string; detail: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-3 text-lg font-semibold">{legend}</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        {options.map((option) => (
          <label key={option.value} className={choiceClass}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            <span className="text-lg font-semibold">{option.label}</span>
            <span className="text-sm text-slate">{option.detail}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const ENGINE_OPTIONS = ENGINES.map((engine) => ({
  value: engine.id,
  label: engine.label,
  detail: `Port ${engine.defaultPort} by default`,
}));

export function EnginePicker({
  value,
  onChange,
}: {
  value: EngineId;
  onChange: (engine: EngineId) => void;
}) {
  return (
    <Choices
      legend="Engine"
      name="engine"
      value={value}
      options={ENGINE_OPTIONS}
      onChange={onChange}
    />
  );
}
